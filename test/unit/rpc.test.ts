import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair, Networks, xdr } from '@stellar/stellar-sdk';
import { describeTransportError, NULL_ACCOUNT, SimulationClient } from '../../src/rpc/client.js';
import {
  classifyError,
  firstLine,
  parseResources,
  parseSimulation,
} from '../../src/rpc/outcome.js';
import { ConfigError, RpcUnavailableError, SpecError } from '../../src/errors.js';
import { toScVal } from '../../src/generate/scval.js';
import { declaredErrorCodes } from '../../src/spec/types.js';
import { startFakeRpc, fakeContractId, type FakeRpc } from '../fake-rpc/server.js';
import {
  buggyVault,
  cleanVault,
  CLEAN_VAULT_ID,
  BUGGY_VAULT_ID,
  vaultSpec,
} from '../fake-rpc/contracts.js';

const declared = declaredErrorCodes(vaultSpec);
const funded = Keypair.random().publicKey();
let rpc: FakeRpc;

beforeAll(async () => {
  rpc = await startFakeRpc({
    contracts: [cleanVault, buggyVault],
    accounts: [funded],
    reportCost: true,
  });
});
afterAll(async () => {
  await rpc.close();
});

function client(
  extra: Partial<ConstructorParameters<typeof SimulationClient>[0]> = {},
): SimulationClient {
  return new SimulationClient({
    rpcUrl: rpc.url,
    networkPassphrase: Networks.STANDALONE,
    retries: 0,
    retryDelayMs: 1,
    ...extra,
  });
}

const i128 = (n: bigint): xdr.ScVal => toScVal({ kind: 'i128' }, n, vaultSpec);

describe('SimulationClient against the fake RPC', () => {
  it('pings and fetches the contract spec over real HTTP', async () => {
    const c = client();
    expect(await c.ping()).toBe(1000);
    const spec = await c.fetchSpec(CLEAN_VAULT_ID);
    expect(spec.functions.map((f) => f.name)).toEqual([
      'div_by',
      'first',
      'balance',
      'roll',
      'compute',
      'transfer',
    ]);
  });

  it('classifies success, declared contract errors and traps', async () => {
    const c = client();
    const ok = await c.simulate(CLEAN_VAULT_ID, 'div_by', [i128(4n)], declared);
    expect(ok.outcome).toEqual({ kind: 'success', retvalXdr: i128(250_000n).toXdr('base64') });
    expect(ok.resources).toMatchObject({
      cpuInstructions: 300_000,
      memoryBytes: 75_000,
      writeEntries: 0,
      readEntries: 1,
    });

    const err = await c.simulate(CLEAN_VAULT_ID, 'div_by', [i128(0n)], declared);
    expect(err.outcome).toMatchObject({
      kind: 'contract-error',
      code: 1,
      name: 'VaultError::DivByZero',
    });
    expect(err.resources).toBeNull();

    const trap = await c.simulate(BUGGY_VAULT_ID, 'div_by', [i128(0n)], declared);
    expect(trap.outcome).toMatchObject({
      kind: 'trap',
      error: 'WasmVm, InvalidAction',
      detail: 'attempt to divide by zero',
    });
    expect(c.simulations).toBe(3);
  });

  it('reads CPU from transactionData and reports memory as null when the RPC omits cost (stellar-rpc 30)', async () => {
    const r = await startFakeRpc({ contracts: [cleanVault] });
    try {
      const c = new SimulationClient({
        rpcUrl: r.url,
        networkPassphrase: Networks.STANDALONE,
        retries: 0,
      });
      const res = await c.simulate(CLEAN_VAULT_ID, 'div_by', [i128(4n)], declared);
      expect(res.resources).toMatchObject({ cpuInstructions: 300_000, memoryBytes: null });
    } finally {
      await r.close();
    }
  });

  it('reports write footprints', async () => {
    const who = toScVal({ kind: 'address' }, NULL_ACCOUNT, vaultSpec);
    const res = await client().simulate(BUGGY_VAULT_ID, 'balance', [who], declared);
    expect(res.resources?.writeEntries).toBe(1);
    expect(res.resources?.writeFootprint).toHaveLength(1);
  });

  it('reports a missing contract as SpecError and an unknown contract call as a simulation outcome', async () => {
    const missing = fakeContractId('nope');
    await expect(client().fetchSpec(missing)).rejects.toThrow(SpecError);
    const res = await client().simulate(missing, 'x', [], declared);
    expect(res.outcome.kind).toBe('trap');
  });

  it('flags a wrong network passphrase as a config error', async () => {
    await expect(client({ networkPassphrase: Networks.TESTNET }).ping()).rejects.toThrow(
      /passphrase mismatch[\s\S]*STELLAR_NETWORK_PASSPHRASE/,
    );
  });

  it('uses a configured source account when it exists and rejects unfunded ones', async () => {
    const c = client({ sourceAccount: funded });
    const tx = await c.buildInvocation(CLEAN_VAULT_ID, 'roll', [xdr.ScVal.scvU32(1)]);
    expect(tx.source).toBe(funded);
    expect(tx.sequence).toBe('4294967297');
    await expect(
      client({ sourceAccount: Keypair.random().publicKey() }).simulate(
        CLEAN_VAULT_ID,
        'roll',
        [xdr.ScVal.scvU32(1)],
        declared,
      ),
    ).rejects.toThrow(ConfigError);
  });

  it('defaults the source account to the null account', async () => {
    const tx = await client().buildInvocation(CLEAN_VAULT_ID, 'roll', [xdr.ScVal.scvU32(1)]);
    expect(tx.source).toBe(NULL_ACCOUNT);
  });

  it('rejects invalid URLs', () => {
    expect(() => client({ rpcUrl: 'not a url' })).toThrow(ConfigError);
  });
});

describe('transport failures', () => {
  it('maps connection refused to RpcUnavailableError', async () => {
    const c = new SimulationClient({
      rpcUrl: 'http://127.0.0.1:9',
      networkPassphrase: Networks.STANDALONE,
      retries: 1,
      retryDelayMs: 1,
    });
    await expect(c.ping()).rejects.toThrow(RpcUnavailableError);
    await expect(c.simulate(CLEAN_VAULT_ID, 'roll', [], declared)).rejects.toThrow(
      /after 2 attempt/,
    );
  });

  it('maps HTTP 5xx / 429 and JSON-RPC errors to RpcUnavailableError', async () => {
    const r = await startFakeRpc({ contracts: [cleanVault] });
    const c = new SimulationClient({
      rpcUrl: r.url,
      networkPassphrase: Networks.STANDALONE,
      retries: 0,
    });
    try {
      r.setFailMode({ kind: 'http-status', status: 503 });
      await expect(c.ping()).rejects.toThrow(/HTTP 503/);
      r.setFailMode({ kind: 'http-status', status: 429 });
      await expect(c.ping()).rejects.toThrow(/rate limited/);
      r.setFailMode({ kind: 'jsonrpc-error' });
      await expect(c.ping()).rejects.toThrow(/JSON-RPC error -32603/);
      await expect(c.fetchSpec(CLEAN_VAULT_ID)).rejects.toThrow(RpcUnavailableError);
    } finally {
      await r.close();
    }
  });

  it('times out on a hanging RPC', async () => {
    const r = await startFakeRpc({ contracts: [cleanVault] });
    r.setFailMode({ kind: 'hang' });
    const c = new SimulationClient({
      rpcUrl: r.url,
      networkPassphrase: Networks.STANDALONE,
      retries: 0,
      timeoutMs: 200,
    });
    try {
      await expect(c.ping()).rejects.toThrow(RpcUnavailableError);
    } finally {
      await r.close();
    }
  });

  it('retries transient failures', async () => {
    const r = await startFakeRpc({ contracts: [cleanVault] });
    // first request fails, later ones succeed
    r.setFailMode({ kind: 'http-status', status: 500, afterRequests: 0 });
    const c = new SimulationClient({
      rpcUrl: r.url,
      networkPassphrase: Networks.STANDALONE,
      retries: 3,
      retryDelayMs: 20,
    });
    const p = c.ping();
    setTimeout(() => r.setFailMode({ kind: 'none' }), 5);
    expect(await p).toBe(1000);
    await r.close();
  });

  it('describes transport errors', () => {
    expect(describeTransportError({ response: { status: 502, statusText: 'Bad Gateway' } })).toBe(
      'HTTP 502 Bad Gateway',
    );
    expect(describeTransportError({ code: -32600, message: 'bad' })).toBe(
      'JSON-RPC error -32600: bad',
    );
    expect(describeTransportError(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))).toBe(
      'ECONNRESET: boom',
    );
    expect(describeTransportError({ cause: { code: 'ECONNREFUSED' } })).toBe('ECONNREFUSED');
    expect(describeTransportError('x')).toBe('x');
    expect(describeTransportError({})).toBe('[object Object]');
  });
});

describe('outcome parsing', () => {
  it('classifies host errors', () => {
    expect(classifyError('HostError: Error(Contract, #3)\n\nEvent log', declared)).toEqual({
      kind: 'contract-error',
      code: 3,
      name: 'VaultError::InsufficientBalance',
      message: 'HostError: Error(Contract, #3)',
    });
    expect(classifyError('HostError: Error(Contract, #99)', declared)).toMatchObject({
      kind: 'trap',
      error: 'Contract, #99 (not declared in the contract spec)',
    });
    expect(classifyError('HostError: Error(Budget, ExceededLimit)', declared)).not.toHaveProperty(
      'detail',
    );
    expect(
      classifyError(
        'HostError: Error(WasmVm, InvalidAction)\n 0: [Diagnostic Event] data:"say \\"hi\\""',
        declared,
      ),
    ).toMatchObject({
      detail: 'say \\"hi\\"',
    });
    expect(classifyError('HostError: Error(Budget, ExceededLimit)', declared)).toMatchObject({
      kind: 'trap',
      error: 'Budget, ExceededLimit',
    });
    expect(classifyError('transaction invalid', declared)).toEqual({
      kind: 'simulation-failed',
      message: 'transaction invalid',
    });
  });

  it('handles odd responses', () => {
    expect(parseSimulation({}, declared).outcome.kind).toBe('simulation-failed');
    expect(parseResources({})).toBeNull();
    expect(firstLine('\n\n  x \ny')).toBe('x');
    expect(firstLine('')).toBe('');
  });
});
