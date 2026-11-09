/**
 * High-level API: the same operations the CLI performs, callable from code.
 */
import { randomInt } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { ConfigError, UsageError } from './errors.js';
import type { ResolvedConfig } from './config/config.js';
import { loadSpecFromFile, resolveTarget } from './spec/load.js';
import type { ContractSpec } from './spec/types.js';
import { SimulationClient } from './rpc/client.js';
import { loadProperties, type Property } from './checks/properties.js';
import { readBaseline, writeBaseline, type BaselineFile } from './baseline/baseline.js';
import { replay as replayRun, run, type RunEvent, type RunReport } from './runner/runner.js';
import { readReplay } from './runner/replay.js';

/** Creates a {@link SimulationClient} from a resolved config. */
export function clientFromConfig(config: ResolvedConfig): SimulationClient {
  if (!config.rpcUrl) {
    throw new UsageError(
      'no RPC URL configured: pass --rpc-url, set STELLAR_RPC_URL, or set "rpcUrl" or "network" in the config file',
    );
  }
  return new SimulationClient({
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
    sourceAccount: config.sourceAccount,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
  });
}

/**
 * Loads a contract spec from a CLI-style target: a `.wasm` / `.json` file, or
 * a deployed contract ID (fetched over RPC; needs `config.rpcUrl`).
 */
export async function inspect(target: string, config: ResolvedConfig): Promise<ContractSpec> {
  const t = resolveTarget(target);
  if (t.kind === 'file') return loadSpecFromFile(t.path);
  const client = clientFromConfig(config);
  await client.ping();
  return client.fetchSpec(t.contractId);
}

/** A target resolved to a spec and the deployed contract to simulate against. */
export interface ResolvedTarget {
  spec: ContractSpec;
  contractId: string;
  client: SimulationClient;
  /** Warnings discovered while resolving (e.g. spec mismatch). */
  notes: string[];
}

/**
 * Resolves a target for fuzzing / cost measurement: checks the RPC is
 * reachable (and on the right network), loads the spec, and makes sure the
 * contract to call exists.
 *
 * @param contractIdOverride - contract to call when `target` is a file (falls back to `config.contractId`)
 */
export async function resolveRunTarget(
  target: string,
  config: ResolvedConfig,
  contractIdOverride?: string,
): Promise<ResolvedTarget> {
  const t = resolveTarget(target);
  const client = clientFromConfig(config);
  await client.ping();
  if (config.sourceAccount && !StrKey.isValidEd25519PublicKey(config.sourceAccount)) {
    throw new ConfigError(
      `source account "${config.sourceAccount}" is not a valid G... public key`,
    );
  }
  if (t.kind === 'contract') {
    return {
      spec: await client.fetchSpec(t.contractId),
      contractId: t.contractId,
      client,
      notes: [],
    };
  }
  const contractId = contractIdOverride ?? config.contractId;
  if (!contractId) {
    throw new UsageError(
      `${target} is a local file; simulation needs a deployed contract. Pass --contract-id <C...> ` +
        '(or set "contractId" in the config), or pass the contract ID as the target.',
    );
  }
  if (!StrKey.isValidContract(contractId))
    throw new UsageError(`"${contractId}" is not a valid contract ID`);
  const spec = await loadSpecFromFile(t.path);
  const deployed = await client.fetchSpec(contractId);
  const notes: string[] = [];
  const local = spec.functions
    .map((f) => f.name)
    .sort()
    .join(',');
  const remote = deployed.functions
    .map((f) => f.name)
    .sort()
    .join(',');
  if (local !== remote) {
    notes.push(
      `the functions in ${target} differ from the deployed contract ${contractId}; is the deployed build up to date?`,
    );
  }
  return { spec, contractId, client, notes };
}

/** Picks the seed to use: explicit, configured, or random. */
export function chooseSeed(...candidates: (number | undefined)[]): number {
  return candidates.find((c) => c !== undefined) ?? randomInt(0, 2 ** 32 - 1);
}

/** Options for {@link fuzz}. */
export interface FuzzOptions {
  /** Path to a `.wasm` / `.json` spec, or a contract ID. */
  target: string;
  config: ResolvedConfig;
  /** Contract to call when `target` is a file. */
  contractId?: string;
  /** Only test these functions. */
  functions?: string[];
  /** Extra property files (in addition to `config.properties`). */
  propertyFiles?: string[];
  /** Extra in-memory properties. */
  properties?: Property[];
  /** Re-run one recorded failure instead of fuzzing. */
  replayFile?: string;
  onEvent?: (e: RunEvent) => void;
}

async function loadBaselineIfPresent(
  config: ResolvedConfig,
): Promise<{ path: string; file: BaselineFile } | undefined> {
  if (!config.checks['cost-regression']) return undefined;
  const file = await readBaseline(config.baseline.path);
  return file ? { path: config.baseline.path, file } : undefined;
}

/**
 * Runs every enabled check against the target (or replays one recorded case).
 * Equivalent to `soroban-testkit fuzz`.
 */
export async function fuzz(options: FuzzOptions): Promise<RunReport> {
  const { config } = options;
  const properties = [
    ...(await loadProperties([...config.properties, ...(options.propertyFiles ?? [])])),
    ...(options.properties ?? []),
  ];
  if (options.replayFile) {
    const r = await readReplay(options.replayFile);
    const t = resolveTarget(options.target);
    const contractId =
      t.kind === 'contract'
        ? t.contractId
        : (options.contractId ?? config.contractId ?? r.contractId);
    const resolved = await resolveRunTarget(options.target, config, contractId);
    const report = await replayRun({
      spec: resolved.spec,
      contractId: resolved.contractId,
      simulator: resolved.client,
      config,
      replay: r,
      properties,
      baseline: r.check === 'cost-regression' ? await loadBaselineIfPresent(config) : undefined,
    });
    if (resolved.contractId !== r.contractId) {
      report.notes.push(
        `replaying against ${resolved.contractId}; the failure was recorded on ${r.contractId}`,
      );
    }
    report.notes.push(...resolved.notes);
    return report;
  }
  const resolved = await resolveRunTarget(options.target, config, options.contractId);
  const seed = chooseSeed(config.seed);
  const report = await run({
    spec: resolved.spec,
    contractId: resolved.contractId,
    simulator: resolved.client,
    config,
    seed,
    runs: config.runs,
    properties,
    baseline: await loadBaselineIfPresent(config),
    functions: options.functions,
    onEvent: options.onEvent,
  });
  report.notes.unshift(...resolved.notes);
  return report;
}

/** What {@link costs} should do with the baseline. */
export type CostsMode = 'measure' | 'update-baseline' | 'check-baseline';

/** Options for {@link costs}. */
export interface CostsOptions {
  target: string;
  config: ResolvedConfig;
  mode: CostsMode;
  contractId?: string;
  functions?: string[];
  /** Explicit seed / runs (otherwise: config, then the existing baseline, then random / default). */
  seed?: number;
  runs?: number;
  onEvent?: (e: RunEvent) => void;
}

/** Result of {@link costs}. */
export interface CostsResult {
  report: RunReport;
  baselinePath: string;
  /** The baseline file written (update mode). */
  written?: BaselineFile;
}

/**
 * Measures per-function costs; optionally writes or checks the baseline.
 * Equivalent to `soroban-testkit costs`.
 */
export async function costs(options: CostsOptions): Promise<CostsResult> {
  const { config, mode } = options;
  const path = config.baseline.path;
  const existing = await readBaseline(path);
  if (mode === 'check-baseline' && !existing) {
    throw new UsageError(
      `no baseline at ${path}; create one with "soroban-testkit costs <target> --update-baseline"`,
    );
  }
  const resolved = await resolveRunTarget(options.target, config, options.contractId);
  const seed = chooseSeed(options.seed, config.seed, existing?.seed);
  const runs = options.runs ?? existing?.runs ?? config.runs;
  const report = await run({
    spec: resolved.spec,
    contractId: resolved.contractId,
    simulator: resolved.client,
    config,
    seed,
    runs,
    mode: 'costs',
    functions: options.functions,
    baseline: mode === 'check-baseline' && existing ? { path, file: existing } : undefined,
    onEvent: options.onEvent,
  });
  report.notes.unshift(...resolved.notes);
  if (mode !== 'update-baseline') return { report, baselinePath: path };
  const written: BaselineFile = {
    version: 1,
    generator: 'soroban-testkit',
    createdAt: new Date().toISOString(),
    contractId: resolved.contractId,
    seed,
    runs,
    functions: Object.fromEntries(
      report.functions.filter((f) => f.costs).map((f) => [f.name, f.costs!]),
    ),
  };
  await writeBaseline(path, written);
  return { report, baselinePath: path, written };
}
