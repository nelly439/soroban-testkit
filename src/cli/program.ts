/**
 * The `soroban-testkit` command line, as a testable function.
 */
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { costs, fuzz, inspect, type CostsMode } from '../api.js';
import {
  loadConfig,
  NETWORK_PRESETS,
  type ConfigOverrides,
  type NetworkPreset,
} from '../config/config.js';
import { ExitCode, TestkitError, UsageError } from '../errors.js';
import {
  displayPath,
  renderJson,
  renderJunit,
  renderMarkdown,
  renderTerminal,
} from '../report/reporters.js';
import { renderSpec } from '../report/inspect.js';
import type { RunEvent, RunReport } from '../runner/runner.js';
import { VERSION } from '../version.js';

/** I/O used by the CLI (injectable for tests). */
export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Whether stdout is a color-capable terminal. */
  color: boolean;
}

function intArg(name: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  return (v: string): number => {
    if (!/^\d+$/.test(v)) throw new InvalidArgumentError(`${name} must be a whole number`);
    const n = Number(v);
    if (n < min || n > max)
      throw new InvalidArgumentError(`${name} must be between ${min} and ${max}`);
    return n;
  };
}

function numArg(name: string) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0)
      throw new InvalidArgumentError(`${name} must be a number >= 0`);
    return n;
  };
}

function collect(v: string, prev: string[] = []): string[] {
  return [
    ...prev,
    ...v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
}

interface ConnectionOpts {
  config?: string;
  network?: NetworkPreset;
  rpcUrl?: string;
  networkPassphrase?: string;
  sourceAccount?: string;
  contractId?: string;
}

interface ReportOpts {
  json?: string | true;
  markdown?: string | true;
  junit?: string | true;
  color: boolean;
}

interface RunOpts extends ConnectionOpts, ReportOpts {
  runs?: number;
  seed?: number;
  function?: string[];
  baseline?: string;
  threshold?: number;
}

function addConnectionOptions(cmd: Command, withContractId: boolean): Command {
  cmd
    .option(
      '-c, --config <file>',
      'config file (default: ./soroban-testkit.config.{ts,mjs,js,json})',
    )
    .addOption(
      new Option('--network <name>', 'network preset').choices(Object.keys(NETWORK_PRESETS)),
    )
    .option('--rpc-url <url>', 'Stellar RPC URL (env STELLAR_RPC_URL)')
    .option(
      '--network-passphrase <passphrase>',
      'network passphrase (env STELLAR_NETWORK_PASSPHRASE)',
    )
    .option(
      '--source-account <account>',
      'source account for simulated transactions (env STELLAR_SOURCE_ACCOUNT)',
    );
  if (withContractId)
    cmd.option('--contract-id <id>', 'deployed contract to call when the target is a local file');
  return cmd;
}

function addRunOptions(cmd: Command): Command {
  return cmd
    .option(
      '-n, --runs <n>',
      'random cases per function and check, after boundary cases (default 100)',
      intArg('--runs', 0),
    )
    .option(
      '-s, --seed <n>',
      'seed for input generation (default: random, always printed)',
      intArg('--seed', 0, 0xffffffff),
    )
    .option(
      '-f, --function <names>',
      'only test these functions (repeatable or comma-separated)',
      collect,
    )
    .option('--baseline <file>', 'baseline file (default .soroban-testkit/baseline.json)')
    .option(
      '--threshold <percent>',
      'allowed cost growth in percent before cost-regression fails (default 10)',
      numArg('--threshold'),
    )
    .option(
      '--json [file]',
      'write a JSON report to <file>, or to stdout instead of the terminal report',
    )
    .option('--markdown [file]', 'write a Markdown report to <file>, or to stdout')
    .option('--junit [file]', 'write a JUnit XML report to <file>, or to stdout')
    .option('--no-color', 'disable colors in the terminal report');
}

/** Resolves a file target against the CLI working directory; contract IDs pass through. */
function targetPath(target: string, io: CliIO): string {
  const p = resolve(io.cwd, target);
  return existsSync(p) ? p : target;
}

function overrides(o: RunOpts | ConnectionOpts): ConfigOverrides {
  const r = o as RunOpts;
  const out: ConfigOverrides = {};
  if (o.network) out.network = o.network;
  if (o.rpcUrl) out.rpcUrl = o.rpcUrl;
  if (o.networkPassphrase) out.networkPassphrase = o.networkPassphrase;
  if (o.sourceAccount) out.sourceAccount = o.sourceAccount;
  if (o.contractId) out.contractId = o.contractId;
  if (r.runs !== undefined) out.runs = r.runs;
  if (r.seed !== undefined) out.seed = r.seed;
  if (r.baseline) out.baselinePath = r.baseline;
  if (r.threshold !== undefined) out.thresholdPercent = r.threshold;
  return out;
}

async function emitReports(
  report: RunReport,
  o: ReportOpts,
  target: string,
  io: CliIO,
): Promise<void> {
  const formats = [
    ['json', o.json, () => renderJson(report)],
    ['markdown', o.markdown, () => renderMarkdown(report, { target })],
    ['junit', o.junit, () => renderJunit(report, { target })],
  ] as const;
  const toStdout = formats.filter(([, v]) => v === true);
  if (toStdout.length > 1) {
    throw new UsageError(
      `only one of --json/--markdown/--junit can write to stdout; give the others a file name`,
    );
  }
  for (const [, v, render] of formats) {
    if (typeof v === 'string') {
      const path = resolve(io.cwd, v);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, render());
    }
  }
  if (toStdout.length === 1) io.stdout(toStdout[0]![2]());
  else io.stdout(renderTerminal(report, { target, color: o.color && io.color }));
}

function progress(io: CliIO): (e: RunEvent) => void {
  return (e) => {
    if (e.type === 'function-start') {
      io.stderr(
        `  ${e.function}: ${e.checks.length > 0 ? e.checks.join(', ') : 'measuring costs'}\n`,
      );
    }
  };
}

/** Builds the commander program. Actions store their exit code in `state.code`. */
export function buildProgram(io: CliIO, state: { code: number }): Command {
  const program = new Command()
    .name('soroban-testkit')
    .description(
      'Spec-driven fuzzing, invariant checks and cost-regression testing for Soroban contracts (simulation only).',
    )
    .version(VERSION)
    .showHelpAfterError('(run with --help for usage)')
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride();

  addConnectionOptions(
    program
      .command('inspect')
      .description(
        'print the contract interface: functions, parameter and return types, structs, enums, errors',
      )
      .argument('<target>', 'path to a .wasm or .json spec file, or a deployed contract ID (C...)')
      .option('--json', 'print the spec as JSON (usable as a spec file)'),
    false,
  ).action(async (target: string, o: ConnectionOpts & { json?: boolean }) => {
    const config = await loadConfig({
      configPath: o.config,
      cwd: io.cwd,
      env: io.env,
      overrides: overrides(o),
    });
    const spec = await inspect(targetPath(target, io), config);
    io.stdout(o.json ? JSON.stringify(spec, null, 2) + '\n' : renderSpec(spec, target));
    state.code = ExitCode.Clean;
  });

  addRunOptions(
    addConnectionOptions(
      program
        .command('fuzz')
        .description(
          'generate inputs for every function, simulate them, and run the enabled checks',
        )
        .argument(
          '<target>',
          'path to a .wasm or .json spec file, or a deployed contract ID (C...)',
        )
        .option(
          '--properties <files>',
          'extra custom property files (repeatable or comma-separated)',
          collect,
        )
        .option(
          '--replay <file>',
          're-run one recorded failure (written to .soroban-testkit/replays/)',
        ),
      true,
    ),
  ).action(async (target: string, o: RunOpts & { properties?: string[]; replay?: string }) => {
    const config = await loadConfig({
      configPath: o.config,
      cwd: io.cwd,
      env: io.env,
      overrides: overrides(o),
    });
    if (!o.replay) {
      io.stderr(
        `soroban-testkit: fuzzing ${target}${config.seed !== undefined ? ` with seed ${config.seed}` : ''}\n`,
      );
    }
    const report = await fuzz({
      target: targetPath(target, io),
      config,
      contractId: o.contractId,
      functions: o.function,
      propertyFiles: (o.properties ?? []).map((p) => resolve(io.cwd, p)),
      replayFile: o.replay ? resolve(io.cwd, o.replay) : undefined,
      onEvent: progress(io),
    });
    await emitReports(report, o, target, io);
    state.code = report.findings.length > 0 ? ExitCode.Findings : ExitCode.Clean;
  });

  addRunOptions(
    addConnectionOptions(
      program
        .command('costs')
        .description(
          'measure CPU, memory, footprint and fee per function; write or check a cost baseline',
        )
        .argument(
          '<target>',
          'path to a .wasm or .json spec file, or a deployed contract ID (C...)',
        )
        .option('--update-baseline', 'write the measured costs to the baseline file')
        .option(
          '--check-baseline',
          'compare with the baseline file; exit 1 if any function got more expensive than the threshold',
        ),
      true,
    ),
  ).action(
    async (target: string, o: RunOpts & { updateBaseline?: boolean; checkBaseline?: boolean }) => {
      if (o.updateBaseline && o.checkBaseline)
        throw new UsageError('use either --update-baseline or --check-baseline, not both');
      const mode: CostsMode = o.updateBaseline
        ? 'update-baseline'
        : o.checkBaseline
          ? 'check-baseline'
          : 'measure';
      const config = await loadConfig({
        configPath: o.config,
        cwd: io.cwd,
        env: io.env,
        overrides: overrides(o),
      });
      io.stderr(`soroban-testkit: measuring costs of ${target}\n`);
      const result = await costs({
        target: targetPath(target, io),
        config,
        mode,
        contractId: o.contractId,
        functions: o.function,
        seed: o.seed,
        runs: o.runs,
        onEvent: progress(io),
      });
      await emitReports(result.report, o, target, io);
      if (result.written)
        io.stderr(`baseline written to ${displayPath(result.baselinePath, io.cwd)}\n`);
      state.code = result.report.findings.length > 0 ? ExitCode.Findings : ExitCode.Clean;
    },
  );

  return program;
}

/**
 * Runs the CLI with the given arguments (without `node` and script path) and
 * returns the exit code: 0 clean, 1 findings, 2 usage/config error, 3 RPC unreachable.
 */
export async function runCli(argv: string[], partialIo: Partial<CliIO> = {}): Promise<number> {
  const io: CliIO = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    ...partialIo,
  };
  const state = { code: ExitCode.Clean as number };
  const program = buildProgram(io, state);
  try {
    if (argv.length === 0) {
      program.outputHelp();
      return ExitCode.Usage;
    }
    await program.parseAsync(argv, { from: 'user' });
    return state.code;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (
        err.code === 'commander.helpDisplayed' ||
        err.code === 'commander.version' ||
        err.code === 'commander.help'
      ) {
        return ExitCode.Clean;
      }
      return ExitCode.Usage;
    }
    if (err instanceof TestkitError) {
      const kind = err.exitCode === ExitCode.RpcUnavailable ? 'RPC unavailable' : 'error';
      io.stderr(`soroban-testkit: ${kind}: ${err.message}\n`);
      if (err.exitCode === ExitCode.RpcUnavailable) {
        io.stderr('This is a transport problem, not a contract bug. No findings were reported.\n');
      }
      return err.exitCode;
    }
    io.stderr(`soroban-testkit: internal error: ${(err as Error)?.stack ?? String(err)}\n`);
    io.stderr('Please report this at https://github.com/nelly439/soroban-testkit/issues\n');
    return ExitCode.Usage;
  }
}
