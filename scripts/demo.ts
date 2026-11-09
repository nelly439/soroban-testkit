/**
 * `make demo`: runs real soroban-testkit commands against the bundled fake
 * RPC (port 8787) and the example contracts, prints them, and saves each
 * output to docs/demo-output/<name>.txt. The documentation quotes these files.
 *
 * Requires `npm run build` first (uses dist/cli.js).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startFakeRpc } from '../test/fake-rpc/server.js';
import {
  BUGGY_VAULT_ID,
  CLEAN_VAULT_ID,
  buggyVault,
  cleanVault,
} from '../test/fake-rpc/contracts.js';
import { demoToken, TOKEN_ID } from '../test/fake-rpc/token.js';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs/demo-output');
const CLI = join(ROOT, 'dist/cli.js');
const PORT = Number(process.env.DEMO_PORT ?? 8787);

if (!existsSync(CLI)) {
  process.stderr.write('dist/cli.js not found: run `npm run build` first (make demo does this)\n');
  process.exit(2);
}

interface Step {
  name: string;
  args: string[];
  /** Expected exit code; the demo fails if it differs. */
  expect: number;
}

const VAULT_CONFIG = 'examples/vault-demo/soroban-testkit.config.json';
const TOKEN_CONFIG = 'examples/custom-properties/soroban-testkit.config.json';
const BASELINE_DIR = join(ROOT, 'examples/vault-demo/.soroban-testkit');

const steps: Step[] = [
  { name: 'inspect-wasm', args: ['inspect', 'examples/wasm/vault_buggy.wasm'], expect: 0 },
  {
    name: 'inspect-contract',
    args: ['inspect', BUGGY_VAULT_ID, '--rpc-url', `http://127.0.0.1:${PORT}`],
    expect: 0,
  },
  {
    name: 'costs-update-baseline',
    args: ['costs', CLEAN_VAULT_ID, '--config', VAULT_CONFIG, '--update-baseline', '--seed', '1'],
    expect: 0,
  },
  {
    name: 'fuzz-buggy',
    args: [
      'fuzz',
      'examples/wasm/vault_buggy.wasm',
      '--contract-id',
      BUGGY_VAULT_ID,
      '--config',
      VAULT_CONFIG,
      '--seed',
      '1',
    ],
    expect: 1,
  },
  {
    name: 'fuzz-clean',
    args: [
      'fuzz',
      'examples/wasm/vault_clean.wasm',
      '--contract-id',
      CLEAN_VAULT_ID,
      '--config',
      VAULT_CONFIG,
      '--seed',
      '1',
    ],
    expect: 0,
  },
  {
    name: 'fuzz-replay',
    args: [
      'fuzz',
      'examples/wasm/vault_buggy.wasm',
      '--contract-id',
      BUGGY_VAULT_ID,
      '--config',
      VAULT_CONFIG,
      '--replay',
      'examples/vault-demo/.soroban-testkit/replays/custom-property--transfer--balance_after_transfer_is_never_negative.json',
    ],
    expect: 1,
  },
  {
    name: 'costs-check-baseline',
    args: ['costs', BUGGY_VAULT_ID, '--config', VAULT_CONFIG, '--check-baseline'],
    expect: 1,
  },
  {
    name: 'fuzz-markdown',
    args: [
      'fuzz',
      BUGGY_VAULT_ID,
      '--config',
      VAULT_CONFIG,
      '--seed',
      '1',
      '--function',
      'div_by,first',
      '--markdown',
    ],
    expect: 1,
  },
  {
    name: 'fuzz-junit',
    args: [
      'fuzz',
      BUGGY_VAULT_ID,
      '--config',
      VAULT_CONFIG,
      '--seed',
      '1',
      '--function',
      'div_by',
      '--junit',
    ],
    expect: 1,
  },
  {
    name: 'fuzz-budget',
    args: [
      'fuzz',
      BUGGY_VAULT_ID,
      '--config',
      'examples/vault-demo/budget.config.json',
      '--seed',
      '1',
      '--function',
      'compute',
    ],
    expect: 1,
  },
  {
    name: 'fuzz-token-properties',
    args: ['fuzz', TOKEN_ID, '--config', TOKEN_CONFIG, '--seed', '1'],
    expect: 1,
  },
  {
    name: 'rpc-down',
    args: ['fuzz', BUGGY_VAULT_ID, '--rpc-url', 'http://127.0.0.1:9', '--seed', '1'],
    expect: 3,
  },
  { name: 'help', args: ['--help'], expect: 0 },
  { name: 'help-fuzz', args: ['fuzz', '--help'], expect: 0 },
  { name: 'help-costs', args: ['costs', '--help'], expect: 0 },
  { name: 'help-inspect', args: ['inspect', '--help'], expect: 0 },
];

const rpc = await startFakeRpc({
  contracts: [cleanVault, buggyVault, demoToken],
  port: PORT,
}).catch((err: Error) => {
  process.stderr.write(`demo: cannot start the fake RPC on port ${PORT}: ${err.message}\n`);
  process.exit(2);
});
rmSync(BASELINE_DIR, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let failed = 0;
try {
  for (const step of steps) {
    // Async spawn: the fake RPC runs in this process and must keep serving.
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (done, fail) => {
        const child = spawn(process.execPath, [CLI, ...step.args], {
          cwd: ROOT,
          env: { PATH: process.env.PATH ?? '', NO_COLOR: '1', COLUMNS: '100' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', fail);
        child.on('close', (status) => done({ status, stdout, stderr }));
      },
    );
    const shown = [
      '$ node dist/cli.js',
      ...step.args.map((a) => (/\s/.test(a) ? `'${a}'` : a)),
    ].join(' ');
    const text = `${shown}\n${res.stderr}${res.stdout}[exit code ${res.status}]\n`;
    writeFileSync(join(OUT, `${step.name}.txt`), text);
    process.stdout.write(`\n${text}`);
    if (res.status !== step.expect) {
      failed++;
      process.stdout.write(`!! ${step.name}: expected exit ${step.expect}, got ${res.status}\n`);
    }
  }
} finally {
  await rpc.close();
}
process.stdout.write(
  `\ndemo: ${steps.length - failed}/${steps.length} commands behaved as expected; outputs saved to docs/demo-output/\n`,
);
process.exit(failed === 0 ? 0 : 1);
