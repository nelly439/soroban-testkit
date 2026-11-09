/**
 * `make verify`: the single command that proves the project works.
 *
 * Runs, in order: lint, type-check, unit tests with coverage (>= 85% lines on
 * src/), the planted-bug e2e test, the build (plus a smoke test of
 * dist/cli.js), and docs-check. Prints a PASS/FAIL summary with counts and
 * exits non-zero if any step fails. Every step runs even if an earlier one
 * failed, so the summary is complete.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, '.verify');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

interface Result {
  name: string;
  ok: boolean;
  detail: string;
  seconds: number;
}

const results: Result[] = [];

function sh(
  cmd: string,
  args: string[],
  env: Record<string, string> = {},
): { code: number; out: string } {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(out);
  return { code: r.status ?? 1, out };
}

function step(name: string, fn: () => { ok: boolean; detail: string }): void {
  process.stdout.write(`\n==> ${name}\n`);
  const t = Date.now();
  let res: { ok: boolean; detail: string };
  try {
    res = fn();
  } catch (err) {
    res = { ok: false, detail: (err as Error).message };
  }
  results.push({ name, ...res, seconds: (Date.now() - t) / 1000 });
}

function vitestCounts(file: string): {
  total: number;
  passed: number;
  failed: number;
  files: number;
} {
  if (!existsSync(file)) return { total: 0, passed: 0, failed: 0, files: 0 };
  const j = JSON.parse(readFileSync(file, 'utf8')) as {
    numTotalTests: number;
    numPassedTests: number;
    numFailedTests: number;
    numTotalTestSuites: number;
    testResults: unknown[];
  };
  return {
    total: j.numTotalTests,
    passed: j.numPassedTests,
    failed: j.numFailedTests,
    files: j.testResults.length,
  };
}

step('lint (eslint + prettier)', () => {
  const eslint = sh('npx', [
    'eslint',
    '.',
    '--format',
    'json',
    '--output-file',
    join(OUT, 'eslint.json'),
  ]);
  const report = existsSync(join(OUT, 'eslint.json'))
    ? (JSON.parse(readFileSync(join(OUT, 'eslint.json'), 'utf8')) as Array<{
        errorCount: number;
        warningCount: number;
      }>)
    : [];
  const errors = report.reduce((n, f) => n + f.errorCount, 0);
  const warnings = report.reduce((n, f) => n + f.warningCount, 0);
  if (errors > 0) sh('npx', ['eslint', '.']);
  const prettier = sh('npx', ['prettier', '--check', '.']);
  return {
    ok: eslint.code === 0 && prettier.code === 0,
    detail: `${report.length} files linted, ${errors} errors, ${warnings} warnings; prettier ${prettier.code === 0 ? 'clean' : 'found unformatted files'}`,
  };
});

step('type-check (tsc --noEmit, strict)', () => {
  const r = sh('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json']);
  const errors = (r.out.match(/error TS\d+/g) ?? []).length;
  return { ok: r.code === 0, detail: `${errors} type errors` };
});

step('unit tests + coverage', () => {
  const r = sh('npx', [
    'vitest',
    'run',
    'test/unit',
    '--coverage',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${join(OUT, 'unit.json')}`,
  ]);
  const c = vitestCounts(join(OUT, 'unit.json'));
  const summaryFile = join(ROOT, 'coverage/coverage-summary.json');
  const lines = existsSync(summaryFile)
    ? (JSON.parse(readFileSync(summaryFile, 'utf8')) as { total: { lines: { pct: number } } }).total
        .lines.pct
    : 0;
  return {
    ok: r.code === 0 && c.failed === 0 && c.total > 0 && lines >= 85,
    detail: `${c.passed}/${c.total} tests passed in ${c.files} files; line coverage ${lines}% (threshold 85%)`,
  };
});

step('planted-bug e2e (real CLI process, fake RPC over HTTP)', () => {
  const r = sh('npx', [
    'vitest',
    'run',
    'test/e2e',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${join(OUT, 'e2e.json')}`,
  ]);
  const c = vitestCounts(join(OUT, 'e2e.json'));
  return {
    ok: r.code === 0 && c.failed === 0 && c.total > 0,
    detail: `${c.passed}/${c.total} e2e tests passed`,
  };
});

step('build (tsup) + dist smoke test', () => {
  const b = sh('npm', ['run', 'build']);
  if (b.code !== 0) return { ok: false, detail: 'build failed' };
  const v = sh('node', ['dist/cli.js', '--version']);
  const i = sh('node', ['dist/cli.js', 'inspect', 'examples/wasm/vault_buggy.wasm']);
  const files = ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js'].filter((f) =>
    existsSync(join(ROOT, f)),
  );
  const ok = v.code === 0 && i.code === 0 && i.out.includes('6 functions') && files.length === 3;
  return {
    ok,
    detail: `${files.length}/3 entry files emitted; dist/cli.js --version = ${v.out.trim().split('\n').pop()}; inspect exit ${i.code}`,
  };
});

step('docs-check', () => {
  const r = sh('npx', ['tsx', 'scripts/docs-check.ts']);
  const m = /docs-check: (\d+) checks passed, (\d+) failed/.exec(r.out);
  return {
    ok: r.code === 0,
    detail: m ? `${m[1]} checks passed, ${m[2]} failed` : 'no summary printed',
  };
});

const pad = Math.max(...results.map((r) => r.name.length));
const lines = [
  '',
  '================================ VERIFY SUMMARY ================================',
  ...results.map(
    (r) =>
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(pad)}  ${r.seconds.toFixed(1).padStart(5)}s  ${r.detail}`,
  ),
  '--------------------------------------------------------------------------------',
];
const failed = results.filter((r) => !r.ok).length;
lines.push(
  failed === 0
    ? `PASS: all ${results.length} steps passed`
    : `FAIL: ${failed} of ${results.length} steps failed`,
);
process.stdout.write(lines.join('\n') + '\n');
process.exit(failed === 0 ? 0 : 1);
