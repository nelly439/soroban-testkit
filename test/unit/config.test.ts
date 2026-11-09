import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import {
  budgetFor,
  checkEnabled,
  defineConfig,
  findConfigFile,
  loadConfig,
  loadConfigFile,
  resolveConfig,
  validateConfig,
} from '../../src/config/config.js';
import { loadProperties } from '../../src/checks/properties.js';
import { ConfigError } from '../../src/errors.js';
import {
  compareCosts,
  computeCosts,
  readBaseline,
  writeBaseline,
  type BaselineFile,
} from '../../src/baseline/baseline.js';

const dir = () => mkdtempSync(join(tmpdir(), 'stk-cfg-'));

describe('validateConfig', () => {
  it('accepts a full config', () => {
    const cfg = defineConfig({
      network: 'testnet',
      rpcUrl: 'http://x',
      networkPassphrase: 'p',
      sourceAccount: 'GA',
      contractId: 'C',
      runs: 0,
      seed: 0,
      timeoutMs: 10,
      retries: 0,
      replayDir: 'r',
      generators: {
        maxCollectionLength: 2,
        maxStringLength: 3,
        maxBytesLength: 4,
        maxDepth: 0,
        maxBoundaryCases: 5,
        addresses: ['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'],
      },
      checks: { budget: false },
      budget: { cpuInstructions: 1, memoryBytes: 2 },
      baseline: { path: 'b.json', thresholdPercent: 0 },
      properties: ['p.ts'],
      functions: {
        f: {
          skip: true,
          readOnly: true,
          checks: { deterministic: false },
          budget: { cpuInstructions: 3 },
        },
      },
    });
    expect(validateConfig(cfg)).toEqual(cfg);
    expect(validateConfig(undefined)).toEqual({});
  });

  it.each([
    [{ bogus: 1 }, /unknown config option "bogus"/],
    [{ network: 'moon' }, /network/],
    [{ runs: -1 }, /runs/],
    [{ runs: 1.5 }, /runs/],
    [{ seed: 2 ** 33 }, /32 bits/],
    [{ rpcUrl: '' }, /rpcUrl/],
    [{ timeoutMs: 0 }, /timeoutMs/],
    [{ generators: 1 }, /generators/],
    [{ generators: { maxFoo: 1 } }, /generators.maxFoo/],
    [{ generators: { addresses: ['nope'] } }, /addresses/],
    [{ checks: { nope: true } }, /checks.nope/],
    [{ checks: { budget: 'yes' } }, /checks.budget/],
    [{ checks: [] }, /checks/],
    [{ budget: 1 }, /budget/],
    [{ budget: { cpuInstructions: 0 } }, /budget.cpuInstructions/],
    [{ baseline: 1 }, /baseline/],
    [{ baseline: { thresholdPercent: -1 } }, /thresholdPercent/],
    [{ properties: 'x' }, /properties/],
    [{ functions: [] }, /functions/],
    [{ functions: { f: 1 } }, /functions.f/],
    [{ functions: { f: { skip: 'y' } } }, /functions.f.skip/],
    [{ functions: { f: { wat: 1 } } }, /functions.f.wat/],
    ['nope', /must be an object/],
  ])('rejects %j', (raw, msg) => {
    expect(() => validateConfig(raw)).toThrow(msg);
  });
});

describe('resolveConfig', () => {
  it('applies defaults', () => {
    const c = resolveConfig({}, undefined, {}, {}, '/w');
    expect(c).toMatchObject({
      rpcUrl: undefined,
      networkPassphrase: Networks.STANDALONE,
      runs: 100,
      timeoutMs: 30000,
      retries: 2,
      replayDir: '/w/.soroban-testkit/replays',
      baseline: { path: '/w/.soroban-testkit/baseline.json', thresholdPercent: 10 },
    });
    expect(Object.values(c.checks).every(Boolean)).toBe(true);
  });

  it('uses network presets, then file, then env, then CLI', () => {
    expect(resolveConfig({ network: 'testnet' }, undefined, {}).rpcUrl).toBe(
      'https://soroban-testnet.stellar.org',
    );
    expect(resolveConfig({ network: 'testnet' }, undefined, {}).networkPassphrase).toBe(
      Networks.TESTNET,
    );
    const file = { network: 'testnet' as const, rpcUrl: 'http://file', sourceAccount: 'GFILE' };
    expect(resolveConfig(file, undefined, {}).rpcUrl).toBe('http://file');
    const env = {
      STELLAR_RPC_URL: 'http://env',
      STELLAR_NETWORK_PASSPHRASE: 'envpass',
      STELLAR_SOURCE_ACCOUNT: 'GENV',
    };
    const fromEnv = resolveConfig(file, undefined, env);
    expect([fromEnv.rpcUrl, fromEnv.networkPassphrase, fromEnv.sourceAccount]).toEqual([
      'http://env',
      'envpass',
      'GENV',
    ]);
    const cli = resolveConfig(file, undefined, env, {
      rpcUrl: 'http://cli',
      runs: 3,
      seed: 9,
      network: 'local',
    });
    expect([cli.rpcUrl, cli.runs, cli.seed]).toEqual(['http://cli', 3, 9]);
    expect(resolveConfig({}, undefined, { STELLAR_RPC_URL: '' }).rpcUrl).toBeUndefined();
  });

  it('resolves paths relative to the config file and baseline flags relative to cwd', () => {
    const c = resolveConfig(
      { properties: ['p.ts', '/abs/q.ts'], baseline: { path: 'b.json' }, replayDir: 'rp' },
      '/proj/cfg/soroban-testkit.config.json',
      {},
      {},
      '/cwd',
    );
    expect(c.properties).toEqual(['/proj/cfg/p.ts', '/abs/q.ts']);
    expect(c.baseline.path).toBe('/proj/cfg/b.json');
    expect(c.replayDir).toBe('/proj/cfg/rp');
    const o = resolveConfig(
      {},
      undefined,
      {},
      { baselinePath: 'x.json', thresholdPercent: 25 },
      '/cwd',
    );
    expect(o.baseline).toEqual({ path: '/cwd/x.json', thresholdPercent: 25 });
  });

  it('computes per-function switches and budgets', () => {
    const c = resolveConfig(
      {
        checks: { budget: false },
        budget: { cpuInstructions: 10, memoryBytes: 5 },
        functions: { f: { checks: { budget: true }, budget: { cpuInstructions: 20 } } },
      },
      undefined,
      {},
    );
    expect(checkEnabled(c, 'f', 'budget')).toBe(true);
    expect(checkEnabled(c, 'g', 'budget')).toBe(false);
    expect(budgetFor(c, 'f')).toEqual({ cpuInstructions: 20, memoryBytes: 5 });
    expect(budgetFor(c, 'g')).toEqual({ cpuInstructions: 10, memoryBytes: 5 });
  });
});

describe('config files', () => {
  it('loads JSON, JS and TS configs', async () => {
    const d = dir();
    writeFileSync(join(d, 'a.json'), JSON.stringify({ runs: 7 }));
    writeFileSync(join(d, 'b.mjs'), 'export default { runs: 8 };');
    writeFileSync(join(d, 'c.ts'), 'const runs: number = 9;\nexport default { runs };');
    expect(await loadConfigFile(join(d, 'a.json'))).toEqual({ runs: 7 });
    expect(await loadConfigFile(join(d, 'b.mjs'))).toEqual({ runs: 8 });
    expect(await loadConfigFile(join(d, 'c.ts'))).toEqual({ runs: 9 });
  });

  it('reports missing, broken and invalid files', async () => {
    const d = dir();
    writeFileSync(join(d, 'bad.json'), '{');
    writeFileSync(join(d, 'invalid.json'), '{"runs": "many"}');
    await expect(loadConfigFile(join(d, 'missing.json'))).rejects.toThrow(/not found/);
    await expect(loadConfigFile(join(d, 'bad.json'))).rejects.toThrow(ConfigError);
    await expect(loadConfigFile(join(d, 'invalid.json'))).rejects.toThrow(/runs/);
  });

  it('discovers soroban-testkit.config.* in the working directory', async () => {
    const d = dir();
    expect(findConfigFile(d)).toBeUndefined();
    writeFileSync(join(d, 'soroban-testkit.config.json'), JSON.stringify({ runs: 4 }));
    expect(findConfigFile(d)).toBe(join(d, 'soroban-testkit.config.json'));
    const c = await loadConfig({ cwd: d, env: {} });
    expect(c.runs).toBe(4);
    expect(c.configFile).toBe(join(d, 'soroban-testkit.config.json'));
    const explicit = await loadConfig({
      cwd: d,
      env: {},
      configPath: 'soroban-testkit.config.json',
      overrides: { runs: 1 },
    });
    expect(explicit.runs).toBe(1);
    expect((await loadConfig({ cwd: dir() })).configFile).toBeUndefined();
  });

  it('loads property files', async () => {
    const d = dir();
    writeFileSync(
      join(d, 'p.ts'),
      "export default [{ name: 'n', function: 'f', check: (_a: unknown, r: unknown) => r !== null }];",
    );
    writeFileSync(
      join(d, 'single.mjs'),
      "export default { name: 'one', function: '*', check: () => true };",
    );
    writeFileSync(join(d, 'broken.mjs'), 'export default {');
    const props = await loadProperties([join(d, 'p.ts'), join(d, 'single.mjs')]);
    expect(props.map((p) => p.name)).toEqual(['n', 'one']);
    await expect(loadProperties([join(d, 'broken.mjs')])).rejects.toThrow(ConfigError);
    await expect(loadProperties([join(d, 'nope.mjs')])).rejects.toThrow(ConfigError);
  });
});

describe('baseline', () => {
  const r = (cpu: number, mem: number | null = cpu, fee = '10', writes = 0) => ({
    resources: {
      cpuInstructions: cpu,
      memoryBytes: mem,
      readEntries: 0,
      writeEntries: writes,
      readBytes: 0,
      writeBytes: 0,
      minResourceFee: fee,
      writeFootprint: [],
    },
    input: `n=${cpu}`,
  });

  it('computes stats', () => {
    expect(computeCosts([])).toBeNull();
    expect(computeCosts([r(10, 1, '5'), r(30, 3, '7', 2), r(20, 2)])).toEqual({
      samples: 3,
      cpuInstructions: { min: 10, max: 30, mean: 20 },
      memoryBytes: { min: 1, max: 3, mean: 2 },
      maxMinResourceFee: '10',
      maxWriteEntries: 2,
      costliestInput: 'n=30',
    });
    expect(computeCosts([r(1, null)])!.memoryBytes).toBeNull();
  });

  it('compares max costs against a threshold', () => {
    const base = {
      a: computeCosts([r(100)])!,
      b: computeCosts([r(100)])!,
      gone: computeCosts([r(1)])!,
      zero: computeCosts([r(0)])!,
    };
    const cur = {
      a: computeCosts([r(140)])!,
      b: computeCosts([r(50)])!,
      fresh: computeCosts([r(1)])!,
      zero: computeCosts([r(5)])!,
    };
    const cmp = compareCosts(base, cur, 10);
    expect(cmp.regressions.map((d) => `${d.function}.${d.metric}:${d.changePercent}`)).toEqual([
      'a.cpuInstructions:40',
      'a.memoryBytes:40',
      'zero.cpuInstructions:Infinity',
      'zero.memoryBytes:Infinity',
    ]);
    expect(cmp.improvements.map((d) => d.function)).toEqual(['b', 'b']);
    expect(cmp.newFunctions).toEqual(['fresh']);
    expect(cmp.missingFunctions).toEqual(['gone']);
    expect(compareCosts(base, { a: computeCosts([r(109)])! }, 10).regressions).toEqual([]);
    expect(
      compareCosts({ z: computeCosts([r(0)])! }, { z: computeCosts([r(0)])! }, 0).regressions,
    ).toEqual([]);
  });

  it('reads and writes baseline files', async () => {
    const d = dir();
    const path = join(d, 'nested', 'baseline.json');
    expect(await readBaseline(path)).toBeUndefined();
    const b: BaselineFile = {
      version: 1,
      generator: 'soroban-testkit',
      createdAt: 'now',
      seed: 1,
      runs: 2,
      functions: {},
    };
    await writeBaseline(path, b);
    expect(await readBaseline(path)).toEqual(b);
    writeFileSync(join(d, 'bad.json'), '{');
    writeFileSync(join(d, 'wrong.json'), '{"version": 2}');
    await expect(readBaseline(join(d, 'bad.json'))).rejects.toThrow(/not valid JSON/);
    await expect(readBaseline(join(d, 'wrong.json'))).rejects.toThrow(/v1 baseline/);
  });
});
