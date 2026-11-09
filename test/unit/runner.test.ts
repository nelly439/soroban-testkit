import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Networks, xdr } from '@stellar/stellar-sdk';
import { resolveConfig, type UserConfig } from '../../src/config/config.js';
import { SimulationClient } from '../../src/rpc/client.js';
import {
  decodeReplayArgs,
  replay,
  run,
  type RunEvent,
  type Simulator,
} from '../../src/runner/runner.js';
import { readReplay, writeReplay } from '../../src/runner/replay.js';
import type { Property } from '../../src/checks/properties.js';
import { computeCosts, type BaselineFile } from '../../src/baseline/baseline.js';
import { RpcUnavailableError, UsageError } from '../../src/errors.js';
import { VERSION } from '../../src/version.js';
import { startFakeRpc, type FakeRpc } from '../fake-rpc/server.js';
import {
  BUGGY_VAULT_ID,
  CLEAN_VAULT_ID,
  buggyVault,
  cleanVault,
  vaultSpec,
} from '../fake-rpc/contracts.js';

let rpc: FakeRpc;
let client: SimulationClient;
const tmp = () => mkdtempSync(join(tmpdir(), 'stk-run-'));

const nonNegative: Property = {
  name: 'balance after transfer is never negative',
  function: 'transfer',
  check: (_args, result) => (result as bigint) >= 0n,
};

const userConfig = (): UserConfig => ({
  replayDir: join(tmp(), 'replays'),
  functions: { balance: { readOnly: true }, div_by: { readOnly: true } },
  budget: { cpuInstructions: 50_000_000 },
});

beforeAll(async () => {
  rpc = await startFakeRpc({ contracts: [cleanVault, buggyVault] });
  client = new SimulationClient({
    rpcUrl: rpc.url,
    networkPassphrase: Networks.STANDALONE,
    retries: 0,
  });
});
afterAll(() => rpc.close());

async function baselineFor(contractId: string, seed: number, runs: number): Promise<BaselineFile> {
  const config = resolveConfig(userConfig(), undefined, {});
  const rep = await run({
    spec: vaultSpec,
    contractId,
    simulator: client,
    config,
    seed,
    runs,
    mode: 'costs',
  });
  return {
    version: 1,
    generator: 'soroban-testkit',
    createdAt: rep.startedAt,
    seed,
    runs,
    functions: Object.fromEntries(
      rep.functions.filter((f) => f.costs).map((f) => [f.name, f.costs!]),
    ),
  };
}

describe('run against the fake vaults', () => {
  it('finds exactly the six planted defects with shrunk counterexamples', async () => {
    const seed = 1234;
    const runs = 30;
    const baseline = await baselineFor(CLEAN_VAULT_ID, seed, runs);
    const config = resolveConfig(userConfig(), undefined, {});
    const events: RunEvent['type'][] = [];
    const report = await run({
      spec: vaultSpec,
      contractId: BUGGY_VAULT_ID,
      simulator: client,
      config,
      seed,
      runs,
      properties: [nonNegative],
      baseline: { path: 'b.json', file: baseline },
      onEvent: (e) => events.push(e.type),
    });
    const got = report.findings.map((f) => `${f.check}:${f.function}:${f.counterexample.display}`);
    expect(got).toEqual([
      'no-unexpected-trap:div_by:amount=0',
      'no-unexpected-trap:first:items=[]',
      'read-only:balance:who="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"',
      'deterministic:roll:salt=0',
      'custom-property:transfer:from="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", to="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", amount=1001',
      expect.stringMatching(/^cost-regression:compute:n=\d+$/),
    ]);
    expect(report.findings.every((f) => f.seed === seed && f.replayFile)).toBe(true);
    expect(report.findings.find((f) => f.check === 'cost-regression')!.message).toMatch(
      /CPU max \d+ -> \d+ \(\+40%\)/,
    );
    expect(report.findings.find((f) => f.check === 'custom-property')!.property).toBe(
      nonNegative.name,
    );
    expect(report.baseline?.comparison.regressions.map((r) => `${r.function}.${r.metric}`)).toEqual(
      ['compute.cpuInstructions'],
    );
    expect(events).toContain('finding');
    expect(report.tool.version).toBe(VERSION);
  });

  it('reports zero findings on the clean vault', async () => {
    const seed = 99;
    const runs = 30;
    const baseline = await baselineFor(CLEAN_VAULT_ID, seed, runs);
    const report = await run({
      spec: vaultSpec,
      contractId: CLEAN_VAULT_ID,
      simulator: client,
      config: resolveConfig(userConfig(), undefined, {}),
      seed,
      runs,
      properties: [nonNegative],
      baseline: { path: 'b.json', file: baseline },
    });
    expect(report.findings).toEqual([]);
    expect(report.notes).toEqual([]);
    const transfer = report.functions.find((f) => f.name === 'transfer')!;
    expect(transfer.outcomes.contractError).toBeGreaterThan(0);
    expect(transfer.checks).toEqual([
      'no-unexpected-trap',
      'deterministic',
      'budget',
      nonNegative.name,
      'cost-regression',
    ]);
  });

  it('is deterministic for a seed', async () => {
    const config = resolveConfig({ ...userConfig(), functions: {} }, undefined, {});
    const a = await run({
      spec: vaultSpec,
      contractId: BUGGY_VAULT_ID,
      simulator: client,
      config,
      seed: 5,
      runs: 10,
      writeReplays: false,
      functions: ['div_by', 'first'],
    });
    const b = await run({
      spec: vaultSpec,
      contractId: BUGGY_VAULT_ID,
      simulator: client,
      config,
      seed: 5,
      runs: 10,
      writeReplays: false,
      functions: ['div_by', 'first'],
    });
    expect(a.findings).toEqual(b.findings);
    expect(a.functions).toEqual(b.functions);
  });

  it('replays recorded failures exactly', async () => {
    const config = resolveConfig(userConfig(), undefined, {});
    const report = await run({
      spec: vaultSpec,
      contractId: BUGGY_VAULT_ID,
      simulator: client,
      config,
      seed: 7,
      runs: 10,
      properties: [nonNegative],
    });
    expect(report.findings).toHaveLength(5);
    for (const f of report.findings) {
      const r = await readReplay(f.replayFile!);
      const again = await replay({
        spec: vaultSpec,
        contractId: BUGGY_VAULT_ID,
        simulator: client,
        config,
        replay: r,
        properties: [nonNegative],
      });
      expect(again.mode).toBe('replay');
      expect(again.findings).toHaveLength(1);
      // details hold observed values (e.g. the two different results), which may vary
      const { replayFile: _r, shrinkSteps: _s, details: _d, ...expected } = f;
      const { shrinkSteps: _s2, details: _d2, ...actual } = again.findings[0]!;
      expect(actual).toEqual(expected);
      // The same input on the clean contract does not fail.
      const clean = await replay({
        spec: vaultSpec,
        contractId: CLEAN_VAULT_ID,
        simulator: client,
        config,
        replay: r,
        properties: [nonNegative],
      });
      expect(clean.findings).toEqual([]);
    }
  });

  it('replays cost regressions by re-measuring with the recorded seed', async () => {
    const baseline = await baselineFor(CLEAN_VAULT_ID, 3, 5);
    const config = resolveConfig({ ...userConfig(), functions: {} }, undefined, {});
    const rep = await run({
      spec: vaultSpec,
      contractId: BUGGY_VAULT_ID,
      simulator: client,
      config,
      seed: 3,
      runs: 5,
      baseline: { path: 'b', file: baseline },
      functions: ['compute'],
    });
    const f = rep.findings.find((x) => x.check === 'cost-regression')!;
    const r = await readReplay(f.replayFile!);
    const again = await replay({
      spec: vaultSpec,
      contractId: BUGGY_VAULT_ID,
      simulator: client,
      config,
      replay: r,
      baseline: { path: 'b', file: baseline },
    });
    expect(again.findings.map((x) => x.message)).toEqual([f.message]);
    await expect(
      replay({ spec: vaultSpec, contractId: BUGGY_VAULT_ID, simulator: client, config, replay: r }),
    ).rejects.toThrow(/baseline/);
  });

  it('rejects unusable replays', async () => {
    const config = resolveConfig({}, undefined, {});
    const base = {
      version: 1 as const,
      contractId: BUGGY_VAULT_ID,
      seed: 1,
      runs: 1,
      argsXdr: [xdr.ScVal.scvU32(1).toXdr('base64')],
      display: '',
      message: '',
    };
    await expect(
      replay({
        spec: vaultSpec,
        contractId: BUGGY_VAULT_ID,
        simulator: client,
        config,
        replay: { ...base, function: 'nope', check: 'deterministic' },
      }),
    ).rejects.toThrow(UsageError);
    await expect(
      replay({
        spec: vaultSpec,
        contractId: BUGGY_VAULT_ID,
        simulator: client,
        config,
        replay: { ...base, function: 'roll', check: 'custom-property', property: 'missing' },
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      replay({
        spec: vaultSpec,
        contractId: BUGGY_VAULT_ID,
        simulator: client,
        config,
        replay: { ...base, function: 'roll', check: 'budget' },
      }),
    ).rejects.toThrow(/thresholds/);
    expect(() => decodeReplayArgs(vaultSpec.functions[5]!, [], vaultSpec)).toThrow(/takes 3/);
    const dir = tmp();
    const p = await writeReplay(dir, {
      ...base,
      function: 'roll',
      check: 'custom-property',
      property: 'a b/c',
    });
    expect(p).toBe(join(dir, 'custom-property--roll--a_b_c.json'));
    expect((await readReplay(p)).property).toBe('a b/c');
    await expect(readReplay(join(dir, 'missing.json'))).rejects.toThrow(UsageError);
    await expect(readReplay(join(import.meta.dirname, '../../package.json'))).rejects.toThrow(
      /not a soroban-testkit replay/,
    );
  });
});

describe('run edge cases', () => {
  it('aborts with RpcUnavailableError, never a finding, when the RPC dies mid-run', async () => {
    const r = await startFakeRpc({ contracts: [buggyVault] });
    const c = new SimulationClient({
      rpcUrl: r.url,
      networkPassphrase: Networks.STANDALONE,
      retries: 0,
    });
    r.setFailMode({ kind: 'http-status', status: 503, afterRequests: 5 });
    const findings: unknown[] = [];
    await expect(
      run({
        spec: vaultSpec,
        contractId: BUGGY_VAULT_ID,
        simulator: c,
        config: resolveConfig(userConfig(), undefined, {}),
        seed: 1,
        runs: 10,
        onEvent: (e) => e.type === 'finding' && findings.push(e),
      }),
    ).rejects.toThrow(RpcUnavailableError);
    expect(findings).toEqual([]);
    await r.close();
  });

  it('aborts during a check (not only during measurement)', async () => {
    let calls = 0;
    const flaky: Simulator = {
      simulate: async (...a) => {
        calls++;
        if (calls > 12) throw new RpcUnavailableError('down');
        return client.simulate(...a);
      },
    };
    await expect(
      run({
        spec: vaultSpec,
        contractId: CLEAN_VAULT_ID,
        simulator: flaky,
        config: resolveConfig({}, undefined, {}),
        seed: 1,
        runs: 5,
        functions: ['roll'],
        writeReplays: false,
      }),
    ).rejects.toThrow(RpcUnavailableError);
  });

  it('skips functions, constructors, and reports config notes', async () => {
    const spec = {
      ...vaultSpec,
      functions: [
        ...vaultSpec.functions,
        { name: '__constructor', doc: '', inputs: [], outputs: [] },
      ],
    };
    const rep = await run({
      spec,
      contractId: CLEAN_VAULT_ID,
      simulator: client,
      config: resolveConfig({ functions: { roll: { skip: true }, ghost: {} } }, undefined, {}),
      seed: 1,
      runs: 2,
      functions: ['roll', '__constructor'],
      properties: [{ name: 'p', function: 'phantom', check: () => true }],
    });
    expect(rep.functions.map((f) => f.skipped)).toEqual([
      'skipped by config',
      'constructors run only at deploy time',
    ]);
    expect(rep.notes).toEqual([
      'config mentions function "ghost", which is not in the contract spec',
      'property "p" targets unknown function "phantom"',
      expect.stringContaining('cost-regression skipped: no baseline'),
    ]);
    await expect(
      run({
        spec,
        contractId: CLEAN_VAULT_ID,
        simulator: client,
        config: resolveConfig({}, undefined, {}),
        seed: 1,
        runs: 1,
        functions: ['nope'],
      }),
    ).rejects.toThrow(/unknown function/);
  });

  it('notes partial simulation failures and fails when all simulations fail', async () => {
    const failing: Simulator = {
      simulate: async () => ({
        outcome: { kind: 'simulation-failed', message: 'bad tx' },
        resources: null,
        latestLedger: 1,
      }),
    };
    await expect(
      run({
        spec: vaultSpec,
        contractId: CLEAN_VAULT_ID,
        simulator: failing,
        config: resolveConfig({}, undefined, {}),
        seed: 1,
        runs: 2,
      }),
    ).rejects.toThrow(/every simulation failed.*bad tx/);
    let n = 0;
    const partial: Simulator = {
      simulate: async (...a) =>
        ++n % 2 === 0
          ? {
              outcome: { kind: 'simulation-failed', message: 'odd' },
              resources: null,
              latestLedger: 1,
            }
          : client.simulate(...a),
    };
    const rep = await run({
      spec: vaultSpec,
      contractId: CLEAN_VAULT_ID,
      simulator: partial,
      config: resolveConfig({ checks: { deterministic: false } }, undefined, {}),
      seed: 1,
      runs: 3,
      functions: ['compute'],
    });
    expect(rep.notes[0]).toMatch(/compute: \d+ of \d+ simulations failed for non-contract reasons/);
    expect(rep.simulationFailures[0]).toMatchObject({ function: 'compute', message: 'odd' });
  });

  it('warns when the baseline was measured with a different seed', async () => {
    const base: BaselineFile = {
      version: 1,
      generator: 'soroban-testkit',
      createdAt: '',
      seed: 1,
      runs: 1,
      functions: {},
    };
    const rep = await run({
      spec: vaultSpec,
      contractId: CLEAN_VAULT_ID,
      simulator: client,
      config: resolveConfig({}, undefined, {}),
      seed: 2,
      runs: 1,
      functions: ['compute'],
      baseline: { path: 'b', file: base },
    });
    expect(rep.notes[0]).toMatch(/baseline was measured with --seed 1 --runs 1/);
    expect(rep.baseline?.comparison.newFunctions).toEqual(['compute']);
    expect(computeCosts([])).toBeNull();
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
