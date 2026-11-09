/**
 * Planted-bug end-to-end test.
 *
 * Runs the real `soroban-testkit` CLI as a child process against the fake
 * Stellar RPC (real HTTP) hosting a CLEAN and a BUGGY vault contract, and
 * proves:
 *
 * 1. exactly the six planted defects are reported on the buggy contract, each
 *    with the right check, function, shrunk counterexample and seed;
 * 2. the clean contract produces zero findings (no false positives);
 * 3. replaying a failure (replay file, or the same --seed) reproduces it identically;
 * 4. a transport failure exits 3 and is never reported as a contract bug;
 * 5. `costs --check-baseline` exits 1 on regression and 0 after `--update-baseline`.
 *
 * Set STK_E2E_CLI=dist to run the built `dist/cli.js` instead of the sources.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import type { RunReport } from '../../src/runner/runner.js';
import { buildWasm } from '../fixtures/wasm-builder.js';
import { startFakeRpc, type FakeRpc } from '../fake-rpc/server.js';
import {
  BUGGY_VAULT_ID,
  CLEAN_VAULT_ID,
  PLANTED_DEFECTS,
  buggyVault,
  cleanVault,
  vaultSpec,
} from '../fake-rpc/contracts.js';

const ROOT = resolve(import.meta.dirname, '../..');
const SEED = 20260101;
const RUNS = 40;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let rpc: FakeRpc;
let work: string;

function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const cliArgs =
    process.env.STK_E2E_CLI === 'dist'
      ? [join(ROOT, 'dist/cli.js')]
      : ['--import', import.meta.resolve('tsx'), join(ROOT, 'src/cli/main.ts')];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...cliArgs, ...args], {
      cwd: work,
      env: {
        PATH: process.env.PATH ?? '',
        NO_COLOR: '1',
        NODE_OPTIONS: '',
        STELLAR_RPC_URL: rpc.url,
        STELLAR_NETWORK_PASSPHRASE: Networks.STANDALONE,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function readReport(name: string): RunReport {
  return JSON.parse(readFileSync(join(work, name), 'utf8')) as RunReport;
}

const PROPERTY_FILE = `// Written by the e2e test. Plain object: no import needed.
export default [
  {
    name: 'balance after transfer is never negative',
    function: 'transfer',
    check: (_args, balanceAfter) => balanceAfter >= 0n,
  },
];
`;

const CONFIG = {
  functions: {
    balance: { readOnly: true },
    div_by: { readOnly: true },
  },
  budget: { cpuInstructions: 100_000_000 },
  baseline: { path: 'baseline.json', thresholdPercent: 10 },
  properties: ['properties.mjs'],
};

beforeAll(async () => {
  rpc = await startFakeRpc({ contracts: [cleanVault, buggyVault] });
  work = mkdtempSync(join(tmpdir(), 'stk-e2e-'));
  writeFileSync(join(work, 'vault.wasm'), buildWasm(vaultSpec));
  writeFileSync(join(work, 'properties.mjs'), PROPERTY_FILE);
  writeFileSync(join(work, 'soroban-testkit.config.json'), JSON.stringify(CONFIG, null, 2));
});

afterAll(async () => {
  await rpc.close();
});

describe('planted-bug end-to-end (real CLI process, fake RPC over HTTP)', () => {
  it('step 0: records a cost baseline from the clean contract', async () => {
    const r = await runCli([
      'costs',
      CLEAN_VAULT_ID,
      '--update-baseline',
      '--seed',
      String(SEED),
      '--runs',
      String(RUNS),
    ]);
    expect(r.stderr).toContain('baseline written to');
    expect(r.code).toBe(0);
    const baseline = JSON.parse(readFileSync(join(work, 'baseline.json'), 'utf8'));
    expect(baseline.seed).toBe(SEED);
    expect(Object.keys(baseline.functions).sort()).toEqual(
      ['compute', 'div_by', 'first', 'roll', 'balance', 'transfer'].sort(),
    );
  });

  it('reports EXACTLY the six planted defects on the buggy contract', async () => {
    const r = await runCli([
      'fuzz',
      'vault.wasm',
      '--contract-id',
      BUGGY_VAULT_ID,
      '--seed',
      String(SEED),
      '--runs',
      String(RUNS),
      '--json',
      'buggy.json',
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`seed ${SEED}`);
    expect(r.stdout).toContain('FINDINGS (6)');
    const report = readReport('buggy.json');

    // exactly six, exactly the planted (check, function) pairs
    expect(report.findings).toHaveLength(6);
    expect(report.findings.map((f) => `${f.check}:${f.function}`).sort()).toEqual(
      PLANTED_DEFECTS.map((d) => `${d.check}:${d.fn}`).sort(),
    );

    const by = (check: string, fn: string) =>
      report.findings.find((f) => f.check === check && f.function === fn)!;
    const ZERO_G = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    // shrunk counterexamples
    expect(by('no-unexpected-trap', 'div_by').counterexample.display).toBe('amount=0');
    expect(by('no-unexpected-trap', 'div_by').message).toBe(
      'trapped with Error(WasmVm, InvalidAction)',
    );
    expect(by('no-unexpected-trap', 'first').counterexample.display).toBe('items=[]');
    expect(by('read-only', 'balance').counterexample.display).toBe(`who="${ZERO_G}"`);
    expect(by('read-only', 'balance').message).toContain('writes 1 ledger entry');
    expect(by('deterministic', 'roll').counterexample.display).toBe('salt=0');
    const prop = by('custom-property', 'transfer');
    expect(prop.property).toBe('balance after transfer is never negative');
    expect(prop.counterexample.display).toBe(`from="${ZERO_G}", to="${ZERO_G}", amount=1001`);
    expect(prop.counterexample.args.amount).toEqual({ $bigint: '1001' });
    expect(prop.message).toContain('(result: -1)');
    const cost = by('cost-regression', 'compute');
    expect(cost.message).toMatch(/^cost grew beyond 10%: CPU max \d+ -> \d+ \(\+40%\)/);

    // every finding carries the seed and a replay file; all but cost-regression are shrunk
    for (const f of report.findings) {
      expect(f.seed).toBe(SEED);
      expect(existsSync(f.replayFile!)).toBe(true);
      expect(f.shrunk).toBe(f.check !== 'cost-regression');
    }
    // transport problems were not involved
    expect(report.simulationFailures).toEqual([]);
  });

  it('reports ZERO findings on the clean contract (no false positives)', async () => {
    const r = await runCli([
      'fuzz',
      'vault.wasm',
      '--contract-id',
      CLEAN_VAULT_ID,
      '--seed',
      String(SEED),
      '--runs',
      String(RUNS),
      '--json',
      'clean.json',
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✓ no findings');
    const report = readReport('clean.json');
    expect(report.findings).toEqual([]);
    // the clean contract exercised the same interesting paths, just correctly
    const fn = (name: string) => report.functions.find((f) => f.name === name)!;
    expect(fn('div_by').outcomes.contractError).toBeGreaterThan(0);
    expect(fn('transfer').outcomes.contractError).toBeGreaterThan(0);
    expect(report.functions.every((f) => f.outcomes.trap === 0)).toBe(true);
    expect(fn('transfer').checks).toContain('balance after transfer is never negative');
    expect(fn('balance').checks).toContain('read-only');
    expect(fn('compute').checks).toContain('cost-regression');
  });

  it('a different seed still finds the same six defects', async () => {
    const r = await runCli([
      'fuzz',
      BUGGY_VAULT_ID,
      '--seed',
      '7',
      '--runs',
      String(RUNS),
      '--baseline',
      'baseline.json',
      '--json',
      'other-seed.json',
    ]);
    expect(r.code).toBe(1);
    // cost comparison across different seeds is approximate, but the 40% jump still shows
    expect(
      readReport('other-seed.json')
        .findings.map((f) => `${f.check}:${f.function}`)
        .sort(),
    ).toEqual(PLANTED_DEFECTS.map((d) => `${d.check}:${d.fn}`).sort());
  });

  it('replaying the same --seed reproduces identical findings', async () => {
    const r = await runCli([
      'fuzz',
      'vault.wasm',
      '--contract-id',
      BUGGY_VAULT_ID,
      '--seed',
      String(SEED),
      '--runs',
      String(RUNS),
      '--json',
      'buggy-again.json',
    ]);
    expect(r.code).toBe(1);
    const strip = (rep: RunReport) =>
      rep.findings.map(
        ({ check, function: fn, property, message, counterexample, seed, shrunk }) => ({
          check,
          fn,
          property,
          message,
          counterexample,
          seed,
          shrunk,
        }),
      );
    expect(strip(readReport('buggy-again.json'))).toEqual(strip(readReport('buggy.json')));
  });

  it('each replay file reproduces the identical failure', async () => {
    const original = readReport('buggy.json');
    for (const f of original.findings) {
      const r = await runCli([
        'fuzz',
        'vault.wasm',
        '--contract-id',
        BUGGY_VAULT_ID,
        '--replay',
        f.replayFile!,
        '--json',
        'replay.json',
      ]);
      expect(r.code, `${f.check}:${f.function}`).toBe(1);
      const replayed = readReport('replay.json');
      expect(replayed.mode).toBe('replay');
      expect(replayed.findings).toHaveLength(1);
      const g = replayed.findings[0]!;
      expect([g.check, g.function, g.property, g.message, g.counterexample, g.seed]).toEqual([
        f.check,
        f.function,
        f.property,
        f.message,
        f.counterexample,
        f.seed,
      ]);
    }
  });

  it('RPC down: exits 3 and reports no contract bug', async () => {
    const r = await runCli(
      ['fuzz', BUGGY_VAULT_ID, '--seed', String(SEED), '--json', 'down.json'],
      {
        STELLAR_RPC_URL: 'http://127.0.0.1:9',
      },
    );
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('RPC unavailable');
    expect(r.stderr).toContain('not a contract bug');
    expect(r.stdout).not.toMatch(/FINDINGS|finding/);
    expect(existsSync(join(work, 'down.json'))).toBe(false);
  });

  it('RPC failing mid-run: exits 3 and reports no contract bug', async () => {
    const flaky = await startFakeRpc({ contracts: [buggyVault] });
    flaky.setFailMode({ kind: 'http-status', status: 503, afterRequests: 25 });
    try {
      const r = await runCli(
        [
          'fuzz',
          BUGGY_VAULT_ID,
          '--seed',
          String(SEED),
          '--runs',
          String(RUNS),
          '--json',
          'midrun.json',
        ],
        {
          STELLAR_RPC_URL: flaky.url,
        },
      );
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('HTTP 503');
      expect(r.stderr).toContain('not a contract bug');
      expect(existsSync(join(work, 'midrun.json'))).toBe(false);
      expect(flaky.requests.simulateTransaction).toBeGreaterThan(0);
    } finally {
      await flaky.close();
    }
  });

  it('--check-baseline exits 1 on regression and 0 after --update-baseline', async () => {
    const check1 = await runCli([
      'costs',
      BUGGY_VAULT_ID,
      '--check-baseline',
      '--json',
      'costs1.json',
    ]);
    expect(check1.code).toBe(1);
    const c1 = readReport('costs1.json');
    expect(c1.seed).toBe(SEED); // reuses the baseline's seed
    expect(c1.findings.map((f) => `${f.check}:${f.function}`)).toEqual(['cost-regression:compute']);
    expect(c1.baseline!.comparison.regressions.map((d) => `${d.function}.${d.metric}`)).toEqual([
      'compute.cpuInstructions',
    ]);

    const update = await runCli(['costs', BUGGY_VAULT_ID, '--update-baseline']);
    expect(update.code).toBe(0);

    const check2 = await runCli([
      'costs',
      BUGGY_VAULT_ID,
      '--check-baseline',
      '--json',
      'costs2.json',
    ]);
    expect(check2.code).toBe(0);
    expect(readReport('costs2.json').findings).toEqual([]);
  });
});
