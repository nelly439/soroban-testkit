/**
 * Proves the custom-property examples in examples/custom-properties/ run and
 * behave as documented against the demo token contract.
 */
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { loadConfig } from '../../src/config/config.js';
import { loadProperties, type Property } from '../../src/checks/properties.js';
import { SimulationClient } from '../../src/rpc/client.js';
import { run } from '../../src/runner/runner.js';
import { startFakeRpc, type FakeRpc } from '../fake-rpc/server.js';
import { demoToken, TOKEN_ADMIN, TOKEN_ID, tokenSpec } from '../fake-rpc/token.js';

const DIR = resolve(import.meta.dirname, '../../examples/custom-properties');
let rpc: FakeRpc;
let client: SimulationClient;

beforeAll(async () => {
  rpc = await startFakeRpc({ contracts: [demoToken] });
  client = new SimulationClient({
    rpcUrl: rpc.url,
    networkPassphrase: Networks.STANDALONE,
    retries: 0,
  });
});
afterAll(() => rpc.close());

async function fuzzWith(files: string[], extra: Partial<Parameters<typeof run>[0]> = {}) {
  const config = await loadConfig({
    configPath: join(DIR, 'soroban-testkit.config.json'),
    env: {},
  });
  const properties: Property[] = await loadProperties(files.map((f) => join(DIR, f)));
  return run({
    spec: tokenSpec,
    contractId: TOKEN_ID,
    simulator: client,
    config: {
      ...config,
      replayDir: join(rpc.url.replace(/\W/g, ''), 'replays'),
      checks: { ...config.checks, 'cost-regression': false },
    },
    seed: 11,
    runs: 20,
    properties,
    writeReplays: false,
    ...extra,
  });
}

describe('examples/custom-properties', () => {
  it('the example config uses the token admin as an extra address', async () => {
    const config = await loadConfig({
      configPath: join(DIR, 'soroban-testkit.config.json'),
      env: {},
    });
    expect(config.generators.addresses).toEqual([TOKEN_ADMIN]);
    expect(config.properties.map((p) => p.split('/').pop())).toEqual([
      'token-balances.ts',
      'access-control.ts',
      'idempotent-reads.ts',
    ]);
  });

  it('token-balances.ts passes on the token (uses ctx.call to read total_supply)', async () => {
    const r = await fuzzWith(['token-balances.ts']);
    expect(r.findings).toEqual([]);
    expect(r.functions.find((f) => f.name === 'balance')!.checks).toContain(
      'no balance exceeds the total supply',
    );
  });

  it('idempotent-reads.ts passes on the token (re-reads with ctx.call)', async () => {
    const before = rpc.requests.simulateTransaction ?? 0;
    const r = await fuzzWith(['idempotent-reads.ts']);
    expect(r.findings).toEqual([]);
    // the property really re-simulated: more simulations than distinct inputs
    expect((rpc.requests.simulateTransaction ?? 0) - before).toBeGreaterThan(
      r.functions.reduce((n, f) => n + f.inputs, 0),
    );
  });

  it('access-control.ts finds the planted missing admin check in mint', async () => {
    const r = await fuzzWith(['access-control.ts']);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0]!;
    expect([f.check, f.function, f.property]).toEqual([
      'custom-property',
      'mint',
      'only the admin can mint',
    ]);
    expect(f.message).toContain('non-admin caller was not rejected (outcome: success)');
    expect(f.counterexample.display).toMatch(/^caller="G[A-Z2-7]+", to="G[A-Z2-7]+", amount=0$/);
    expect(f.counterexample.args.caller).not.toBe(TOKEN_ADMIN);
  });

  it('ctx.call reports unknown functions and missing arguments as property errors', async () => {
    const r = await fuzzWith([], {
      functions: ['admin'],
      properties: [
        {
          name: 'unknown fn',
          function: 'admin',
          check: async (_a, _r, ctx) => (await ctx.call('nope')).result === 1,
        },
        {
          name: 'missing arg',
          function: 'admin',
          check: async (_a, _r, ctx) => (await ctx.call('balance', {})).result === 1,
        },
        {
          name: 'positional',
          function: 'admin',
          check: async (_a, _r, ctx) => (await ctx.call('balance', [TOKEN_ADMIN])).result === 1000n,
        },
      ],
    });
    expect(r.findings.map((f) => `${f.property}: ${f.message}`)).toEqual([
      'unknown fn: property "unknown fn" threw: ctx.call: unknown function "nope"',
      'missing arg: property "missing arg" threw: ctx.call: missing argument "id" for balance',
    ]);
  });
});
