import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { runCli } from '../../src/cli/program.js';
import { costs, fuzz, inspect } from '../../src/api.js';
import { resolveConfig } from '../../src/config/config.js';
import { buildWasm } from '../fixtures/wasm-builder.js';
import { allTypesSpec } from '../fixtures/specs.js';
import { startFakeRpc, type FakeRpc } from '../fake-rpc/server.js';
import {
  BUGGY_VAULT_ID,
  CLEAN_VAULT_ID,
  buggyVault,
  cleanVault,
  vaultSpec,
} from '../fake-rpc/contracts.js';

let rpc: FakeRpc;
let dir: string;

beforeAll(async () => {
  rpc = await startFakeRpc({ contracts: [cleanVault, buggyVault] });
});
afterAll(() => rpc.close());

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'stk-cli-'));
  writeFileSync(join(dir, 'vault.wasm'), buildWasm(vaultSpec));
  writeFileSync(join(dir, 'all.wasm'), buildWasm(allTypesSpec));
  return dir;
}

async function cli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { STELLAR_RPC_URL: rpc.url, STELLAR_NETWORK_PASSPHRASE: Networks.STANDALONE, ...env },
    cwd: dir,
    color: false,
  });
  return { code, out, err };
}

describe('cli basics', () => {
  beforeAll(freshDir);

  it('prints help and version with exit 0, and usage errors with exit 2', async () => {
    expect((await cli(['--help'])).code).toBe(0);
    const v = await cli(['--version']);
    expect([v.code, v.out.trim()]).toEqual([0, '0.1.0']);
    expect((await cli([])).code).toBe(2);
    expect((await cli(['bogus'])).code).toBe(2);
    expect((await cli(['fuzz'])).code).toBe(2);
    expect((await cli(['fuzz', 'vault.wasm', '--runs', 'many'])).code).toBe(2);
    expect((await cli(['fuzz', 'vault.wasm', '--seed', '99999999999'])).code).toBe(2);
    expect((await cli(['costs', 'vault.wasm', '--threshold', '-1'])).code).toBe(2);
    expect((await cli(['inspect', 'all.wasm', '--network', 'moon'])).code).toBe(2);
  });

  it('inspects a wasm file', async () => {
    const r = await cli(['inspect', 'all.wasm']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      'udts(point: Point, pair: Pair, kind: Kind, color: Color, code: Error) -> Result<Point, Error>',
    );
    expect(r.out).toContain('struct Pair(u64, bool)');
    expect(r.out).toContain('union Kind { Empty, One(u32), Nested(Point, Symbol) }');
    expect(r.out).toContain('enum Color { Red = 0, Green = 1, Blue = 7 }');
    expect(r.out).toContain('error Error { NotFound = 1, Overflow = 2 }');
  });

  it('inspects as JSON that can be fed back as a spec file', async () => {
    const r = await cli(['inspect', 'all.wasm', '--json']);
    writeFileSync(join(dir, 'spec.json'), r.out);
    const again = await cli(['inspect', 'spec.json']);
    expect(again.code).toBe(0);
    expect(again.out).toContain('primitives(a_bool: bool');
  });

  it('inspects a deployed contract over RPC', async () => {
    const r = await cli(['inspect', CLEAN_VAULT_ID]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      'transfer(from: Address, to: Address, amount: i128) -> Result<i128, VaultError>',
    );
  });

  it('reports bad targets and missing settings as usage errors', async () => {
    expect((await cli(['inspect', 'nope.wasm'])).code).toBe(2);
    const noRpc = await runCli(['inspect', CLEAN_VAULT_ID], {
      stdout: () => {},
      stderr: () => {},
      env: {},
      cwd: dir,
      color: false,
    });
    expect(noRpc).toBe(2);
    const noId = await cli(['fuzz', 'vault.wasm']);
    expect([noId.code, noId.err]).toEqual([2, expect.stringContaining('--contract-id')]);
    expect((await cli(['fuzz', 'vault.wasm', '--contract-id', 'CNOPE'])).code).toBe(2);
    expect((await cli(['fuzz', CLEAN_VAULT_ID, '--source-account', 'nope'])).code).toBe(2);
    expect(
      (await cli(['fuzz', CLEAN_VAULT_ID, '--network-passphrase', Networks.TESTNET])).err,
    ).toMatch(/passphrase mismatch/);
    expect(
      (await cli(['costs', CLEAN_VAULT_ID, '--update-baseline', '--check-baseline'])).code,
    ).toBe(2);
    expect((await cli(['costs', CLEAN_VAULT_ID, '--check-baseline'])).err).toMatch(/no baseline/);
    expect((await cli(['fuzz', CLEAN_VAULT_ID, '--function', 'nope'])).code).toBe(2);
    expect((await cli(['fuzz', CLEAN_VAULT_ID, '--replay', 'missing.json'])).code).toBe(2);
  });

  it('exits 3 when the RPC is unreachable', async () => {
    const r = await cli(['fuzz', CLEAN_VAULT_ID, '--rpc-url', 'http://127.0.0.1:9'], {});
    expect(r.code).toBe(3);
    expect(r.err).toContain('RPC unavailable');
    expect(r.err).toContain('not a contract bug');
    expect(r.out).toBe('');
  });
});

describe('cli fuzz / costs', () => {
  beforeAll(freshDir);

  it('exits 0 on the clean vault and 1 on the buggy vault', async () => {
    const clean = await cli([
      'fuzz',
      'vault.wasm',
      '--contract-id',
      CLEAN_VAULT_ID,
      '--runs',
      '10',
      '--seed',
      '1',
    ]);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain('✓ no findings');
    expect(clean.err).toContain('with seed 1');
    const buggy = await cli(['fuzz', BUGGY_VAULT_ID, '--runs', '10', '--seed', '1']);
    expect(buggy.code).toBe(1);
    expect(buggy.out).toContain('FINDINGS (3)');
  });

  it('writes reports to files and to stdout', async () => {
    const r = await cli([
      'fuzz',
      BUGGY_VAULT_ID,
      '--runs',
      '5',
      '--seed',
      '2',
      '-f',
      'div_by,first',
      '--function',
      'roll',
      '--json',
      'out/r.json',
      '--markdown',
      'out/r.md',
      '--junit',
      'out/r.xml',
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FINDINGS');
    expect(JSON.parse(readFileSync(join(dir, 'out/r.json'), 'utf8')).findings).toHaveLength(3);
    expect(readFileSync(join(dir, 'out/r.md'), 'utf8')).toContain('❌ 3 findings');
    expect(readFileSync(join(dir, 'out/r.xml'), 'utf8')).toContain('failures="3"');
    const json = await cli([
      'fuzz',
      BUGGY_VAULT_ID,
      '--runs',
      '2',
      '--seed',
      '2',
      '-f',
      'div_by',
      '--json',
    ]);
    expect(JSON.parse(json.out).findings[0].check).toBe('no-unexpected-trap');
    const md = await cli(['fuzz', BUGGY_VAULT_ID, '--runs', '2', '-f', 'div_by', '--markdown']);
    expect(md.out).toMatch(/^## soroban-testkit fuzz/);
    const xml = await cli(['fuzz', BUGGY_VAULT_ID, '--runs', '2', '-f', 'div_by', '--junit']);
    expect(xml.out).toMatch(/^<\?xml/);
    expect((await cli(['fuzz', BUGGY_VAULT_ID, '--json', '--junit'])).code).toBe(2);
  });

  it('uses config files and property files', async () => {
    writeFileSync(
      join(dir, 'soroban-testkit.config.json'),
      JSON.stringify({
        runs: 5,
        seed: 3,
        functions: { balance: { readOnly: true } },
        properties: ['props.mjs'],
      }),
    );
    writeFileSync(
      join(dir, 'props.mjs'),
      "export default [{ name: 'non-negative', function: 'transfer', check: (_a, r) => r >= 0n }];",
    );
    const r = await cli(['fuzz', BUGGY_VAULT_ID, '-f', 'balance,transfer', '--json']);
    const report = JSON.parse(r.out);
    expect(report.seed).toBe(3);
    expect(report.findings.map((f: { check: string }) => f.check)).toEqual([
      'read-only',
      'custom-property',
    ]);
    writeFileSync(
      join(dir, 'extra.mjs'),
      "export default { name: 'never', function: 'roll', check: () => false };",
    );
    const extra = await cli([
      'fuzz',
      CLEAN_VAULT_ID,
      '-f',
      'roll',
      '--properties',
      'extra.mjs',
      '--json',
    ]);
    expect(JSON.parse(extra.out).findings[0].property).toBe('never');
    writeFileSync(join(dir, 'bad.json'), '{"runs": -4}');
    expect((await cli(['fuzz', BUGGY_VAULT_ID, '--config', 'bad.json'])).code).toBe(2);
  });

  it('replays a recorded failure', async () => {
    const first = await cli(['fuzz', BUGGY_VAULT_ID, '-f', 'div_by', '--runs', '3', '--json']);
    const replayFile = JSON.parse(first.out).findings[0].replayFile as string;
    expect(existsSync(replayFile)).toBe(true);
    const again = await cli(['fuzz', BUGGY_VAULT_ID, '--replay', replayFile]);
    expect(again.code).toBe(1);
    expect(again.out).toContain('counterexample: amount=0');
    const onClean = await cli(['fuzz', CLEAN_VAULT_ID, '--replay', replayFile]);
    expect(onClean.code).toBe(0);
    expect(onClean.out).toContain(`the failure was recorded on ${BUGGY_VAULT_ID}`);
    const viaFile = await cli(['fuzz', 'vault.wasm', '--replay', replayFile]);
    expect(viaFile.code).toBe(1);
  });

  it('updates and checks cost baselines', async () => {
    freshDir();
    const upd = await cli([
      'costs',
      CLEAN_VAULT_ID,
      '--update-baseline',
      '--runs',
      '5',
      '--seed',
      '8',
    ]);
    expect(upd.code).toBe(0);
    expect(upd.err).toContain('baseline written to');
    const baseline = JSON.parse(readFileSync(join(dir, '.soroban-testkit/baseline.json'), 'utf8'));
    expect([baseline.seed, baseline.runs, Object.keys(baseline.functions).length]).toEqual([
      8, 5, 6,
    ]);
    const same = await cli(['costs', CLEAN_VAULT_ID, '--check-baseline']);
    expect(same.code).toBe(0);
    const regress = await cli(['costs', BUGGY_VAULT_ID, '--check-baseline']);
    expect(regress.code).toBe(1);
    expect(regress.out).toContain('regression  compute cpuInstructions');
    const loose = await cli(['costs', BUGGY_VAULT_ID, '--check-baseline', '--threshold', '50']);
    expect(loose.code).toBe(0);
    const measure = await cli(['costs', BUGGY_VAULT_ID, '--runs', '2']);
    expect([measure.code, measure.out]).toEqual([0, expect.stringContaining('COSTS')]);
    const other = await cli([
      'costs',
      BUGGY_VAULT_ID,
      '--update-baseline',
      '--baseline',
      'b2.json',
      '--runs',
      '2',
    ]);
    expect(other.code).toBe(0);
    expect(existsSync(join(dir, 'b2.json'))).toBe(true);
    // fuzz also picks up the default baseline for cost-regression
    const fz = await cli(['fuzz', BUGGY_VAULT_ID, '-f', 'compute', '--json']);
    const rep = JSON.parse(fz.out);
    expect(rep.findings.map((f: { check: string }) => f.check)).toEqual(['cost-regression']);
    expect(rep.seed).not.toBe(undefined);
  });
});

describe('library API', () => {
  it('mirrors the CLI', async () => {
    const d = freshDir();
    const config = resolveConfig(
      { replayDir: join(d, 'r'), baseline: { path: join(d, 'b.json') } },
      undefined,
      {
        STELLAR_RPC_URL: rpc.url,
      },
    );
    expect((await inspect(join(d, 'vault.wasm'), config)).functions).toHaveLength(6);
    const report = await fuzz({
      target: BUGGY_VAULT_ID,
      config: { ...config, runs: 3 },
      functions: ['transfer'],
      properties: [{ name: 'p', function: 'transfer', check: (_a, r) => (r as bigint) >= 0n }],
    });
    expect(report.findings.map((f) => f.counterexample.display)).toEqual([
      expect.stringContaining('amount=1001'),
    ]);
    const c = await costs({
      target: CLEAN_VAULT_ID,
      config,
      mode: 'update-baseline',
      runs: 2,
      seed: 1,
    });
    expect(c.written?.seed).toBe(1);
    const chk = await costs({ target: CLEAN_VAULT_ID, config, mode: 'check-baseline' });
    expect(chk.report.seed).toBe(1);
    expect(chk.report.runs).toBe(2);
  });
});
