/**
 * Optional real-network integration test (`make integration`).
 *
 * 1. builds examples/rust-contracts (clean + buggy vault) if the wasm files are missing
 * 2. starts a local Stellar network (docker: stellar/quickstart --local)
 *    unless STK_INTEGRATION_RPC_URL points at an existing local network
 * 3. funds an account with friendbot and deploys both contracts with the JS SDK
 * 4. runs the real soroban-testkit CLI against the real RPC
 * 5. checks: planted bugs are flagged on the buggy contract, zero findings on the clean one
 *
 * Prerequisites: Docker (or STK_INTEGRATION_RPC_URL), and either the prebuilt
 * examples/wasm/*.wasm files or Rust with the wasm32v1-none target.
 * When a prerequisite is missing the script prints SKIPPED and exits 0.
 */
import { spawnSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';

const ROOT = resolve(import.meta.dirname, '..');
const WASM_DIR = join(ROOT, 'examples/wasm');
const CONTAINER = 'soroban-testkit-integration';
const PORT = Number(process.env.STK_INTEGRATION_PORT ?? 8000);
const PASSPHRASE = Networks.STANDALONE;
const SEED = 4242;
const RUNS = Number(process.env.STK_INTEGRATION_RUNS ?? 25);

function log(msg: string): void {
  process.stdout.write(`[integration] ${msg}\n`);
}

function skip(reason: string): never {
  log(`SKIPPED: ${reason}`);
  log(
    'The real-network integration test did NOT run. Nothing was verified against a real network.',
  );
  process.exit(0);
}

function has(cmd: string, args = ['--version']): boolean {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const server = new rpc.Server(url, { allowHttp: true });
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    try {
      const h = await server.getHealth();
      if (h.status === 'healthy') return;
      last = h.status;
    } catch (err) {
      last = (err as Error).message;
    }
    await sleep(2000);
  }
  throw new Error(`RPC at ${url} not healthy after ${timeoutMs / 1000}s (last: ${last})`);
}

async function fund(base: string, account: string): Promise<void> {
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const res = await fetch(`${base}/friendbot?addr=${account}`).catch(() => undefined);
    if (res?.ok) return;
    await sleep(3000);
  }
  throw new Error('friendbot did not fund the deployer account');
}

async function submit(
  server: rpc.Server,
  kp: Keypair,
  op: xdr.Operation,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const account = await server.getAccount(kp.publicKey());
  let tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(120)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === 'ERROR')
    throw new Error(
      `sendTransaction failed: ${JSON.stringify(sent.errorResult?.toJson?.() ?? sent)}`,
    );
  const res = await server.pollTransaction(sent.hash, { attempts: 60 });
  if (res.status !== 'SUCCESS')
    throw new Error(`transaction ${sent.hash} ended with ${res.status}`);
  return res as rpc.Api.GetSuccessfulTransactionResponse;
}

async function deploy(server: rpc.Server, kp: Keypair, wasm: Buffer): Promise<string> {
  await submit(server, kp, Operation.uploadContractWasm({ wasm }));
  const hash = createHash('sha256').update(wasm).digest();
  const res = await submit(
    server,
    kp,
    Operation.createCustomContract({
      address: new Address(kp.publicKey()),
      wasmHash: hash,
      salt: randomBytes(32),
    }),
  );
  if (!res.returnValue) throw new Error('createCustomContract returned no address');
  return Address.fromScVal(res.returnValue).toString();
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], rpcUrl: string): Promise<CliRun> {
  const dist = join(ROOT, 'dist/cli.js');
  const cli = existsSync(dist)
    ? [dist]
    : ['--import', import.meta.resolve('tsx'), join(ROOT, 'src/cli/main.ts')];
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [...cli, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        NO_COLOR: '1',
        STELLAR_RPC_URL: rpcUrl,
        STELLAR_NETWORK_PASSPHRASE: PASSPHRASE,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', rej);
    child.on('close', (code) => res({ code, stdout, stderr }));
  });
}

interface Report {
  findings: Array<{
    check: string;
    function: string;
    message: string;
    counterexample: { display: string };
  }>;
  functions: Array<{
    name: string;
    outcomes: Record<string, number>;
    costs: { cpuInstructions: { max: number }; memoryBytes: { max: number } | null } | null;
  }>;
}

async function main(): Promise<void> {
  const clean = join(WASM_DIR, 'vault_clean.wasm');
  const buggy = join(WASM_DIR, 'vault_buggy.wasm');
  if (!existsSync(clean) || !existsSync(buggy) || process.env.STK_INTEGRATION_REBUILD) {
    if (!has('cargo')) skip('examples/wasm/*.wasm are missing and Rust (cargo) is not installed');
    log('building example contracts with cargo ...');
    const b = spawnSync(join(ROOT, 'examples/rust-contracts/build.sh'), { stdio: 'inherit' });
    if (b.status !== 0)
      skip('building examples/rust-contracts failed (is the wasm32v1-none target installed?)');
  }

  let rpcUrl = process.env.STK_INTEGRATION_RPC_URL;
  let started = false;
  if (!rpcUrl) {
    if (!has('docker', ['info']))
      skip('Docker is not available and STK_INTEGRATION_RPC_URL is not set');
    spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
    log('starting stellar/quickstart --local (first start can take a few minutes) ...');
    const run = spawnSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        CONTAINER,
        '-p',
        `${PORT}:8000`,
        'stellar/quickstart:latest',
        '--local',
        '--enable',
        'core,horizon,rpc',
        '--limits',
        'unlimited',
      ],
      { encoding: 'utf8' },
    );
    if (run.status !== 0) skip(`could not start the quickstart container: ${run.stderr.trim()}`);
    started = true;
    rpcUrl = `http://localhost:${PORT}/rpc`;
  }
  const base = rpcUrl.replace(/\/rpc\/?$/, '');
  const failures: string[] = [];
  try {
    await waitForRpc(rpcUrl, 300_000);
    log(`RPC healthy at ${rpcUrl}`);
    const server = new rpc.Server(rpcUrl, { allowHttp: true });
    const kp = Keypair.random();
    await fund(base, kp.publicKey());
    const cleanId = await deploy(server, kp, readFileSync(clean));
    const buggyId = await deploy(server, kp, readFileSync(buggy));
    log(`deployed clean vault ${cleanId}`);
    log(`deployed buggy vault ${buggyId}`);
    // Record which fields this RPC returns from simulateTransaction (for the docs).
    const probe = await new (await import('../src/rpc/client.js')).SimulationClient({
      rpcUrl,
      networkPassphrase: PASSPHRASE,
    }).buildInvocation(cleanId, 'compute', [
      (await import('@stellar/stellar-sdk')).xdr.ScVal.scvU32(1),
    ]);
    const raw = (await server._simulateTransaction(probe)) as unknown as Record<string, unknown>;
    log(`simulateTransaction response fields: ${Object.keys(raw).sort().join(', ')}`);
    const version = await server.getVersionInfo().catch(() => undefined);
    if (version) log(`RPC version ${version.version}, protocol ${version.protocolVersion}`);

    const work = mkdtempSync(join(tmpdir(), 'stk-integration-'));
    writeFileSync(
      join(work, 'properties.mjs'),
      "export default [{ name: 'balance after transfer is never negative', function: 'transfer', check: (_a, b) => b >= 0n }];\n",
    );
    writeFileSync(
      join(work, 'soroban-testkit.config.json'),
      JSON.stringify(
        {
          functions: { balance: { readOnly: true }, div_by: { readOnly: true } },
          properties: ['properties.mjs'],
        },
        null,
        2,
      ),
    );

    const step = async (name: string, args: string[], expectCode: number): Promise<CliRun> => {
      const r = await runCli(work, args, rpcUrl!);
      log(`${name}: exit ${r.code}`);
      if (r.code !== expectCode) {
        failures.push(`${name}: expected exit ${expectCode}, got ${r.code}\n${r.stderr}`);
      }
      return r;
    };

    await step(
      'costs clean --update-baseline',
      ['costs', cleanId, '--update-baseline', '--seed', String(SEED), '--runs', String(RUNS)],
      0,
    );
    const b = await step(
      'fuzz buggy',
      [
        'fuzz',
        buggy,
        '--contract-id',
        buggyId,
        '--seed',
        String(SEED),
        '--runs',
        String(RUNS),
        '--json',
        'buggy.json',
      ],
      1,
    );
    process.stdout.write(b.stderr);
    const c = await step(
      'fuzz clean',
      [
        'fuzz',
        clean,
        '--contract-id',
        cleanId,
        '--seed',
        String(SEED),
        '--runs',
        String(RUNS),
        '--json',
        'clean.json',
      ],
      0,
    );
    process.stdout.write(c.stderr);

    const buggyReport = existsSync(join(work, 'buggy.json'))
      ? (JSON.parse(readFileSync(join(work, 'buggy.json'), 'utf8')) as Report)
      : undefined;
    const cleanReport = existsSync(join(work, 'clean.json'))
      ? (JSON.parse(readFileSync(join(work, 'clean.json'), 'utf8')) as Report)
      : undefined;

    const expected: Array<[string, string, boolean]> = [
      ['no-unexpected-trap', 'div_by', true],
      ['no-unexpected-trap', 'first', true],
      ['read-only', 'balance', true],
      ['custom-property', 'transfer', true],
      ['cost-regression', 'compute', true],
      // Only detectable if the RPC seeds the PRNG differently per simulation.
      ['deterministic', 'roll', false],
    ];
    log('');
    log('BUGGY contract findings (real network):');
    for (const f of buggyReport?.findings ?? []) {
      log(`  ${f.check} · ${f.function}: ${f.message} [${f.counterexample.display}]`);
    }
    log('');
    log('Planted defect                         result');
    for (const [check, fn, required] of expected) {
      const hit =
        buggyReport?.findings.some((f) => f.check === check && f.function === fn) ?? false;
      log(
        `  ${`${check}:${fn}`.padEnd(37)} ${hit ? 'DETECTED' : required ? 'MISSED' : 'not detected (see note)'}`,
      );
      if (!hit && required) failures.push(`planted defect ${check}:${fn} was not detected`);
    }
    // Real side effects of planted bugs that the fake RPC does not model.
    const secondary: Array<[string, string, string]> = [
      [
        'cost-regression',
        'balance',
        'the planted storage write in balance() really costs extra CPU on a real network',
      ],
    ];
    for (const f of buggyReport?.findings ?? []) {
      if (expected.some(([c, fn]) => c === f.check && fn === f.function)) continue;
      const why = secondary.find(([c, fn]) => c === f.check && fn === f.function);
      if (why) log(`  also found ${f.check}:${f.function} (expected side effect: ${why[2]})`);
      else
        failures.push(
          `unexpected finding on buggy contract: ${f.check}:${f.function}: ${f.message}`,
        );
    }
    log('');
    log(`CLEAN contract findings: ${cleanReport?.findings.length ?? 'no report'}`);
    for (const f of cleanReport?.findings ?? []) {
      failures.push(`false positive on clean contract: ${f.check}:${f.function}: ${f.message}`);
    }
    log('');
    log('Real costs measured (clean contract, max over successful simulations):');
    for (const f of cleanReport?.functions ?? []) {
      log(
        `  ${f.name.padEnd(10)} cpu ${f.costs?.cpuInstructions.max ?? '-'}  mem ${f.costs?.memoryBytes?.max ?? 'n/a'}  outcomes ${JSON.stringify(f.outcomes)}`,
      );
    }
  } catch (err) {
    failures.push(`integration error: ${(err as Error).stack ?? String(err)}`);
  } finally {
    if (started && !process.env.STK_INTEGRATION_KEEP) {
      spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
      log('stopped the quickstart container');
    }
  }
  log('');
  if (failures.length > 0) {
    log(`FAIL (${failures.length} problem(s)):`);
    for (const f of failures) log(`  - ${f}`);
    process.exit(1);
  }
  log(
    'PASS: planted bugs flagged on the buggy contract, zero findings on the clean contract (real local network).',
  );
}

await main();
