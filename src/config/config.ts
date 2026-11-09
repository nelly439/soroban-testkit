/**
 * Configuration: schema, defaults, validation, file loading and
 * environment-variable overrides.
 *
 * Precedence (highest first): CLI flags, environment variables, config file,
 * network preset, built-in defaults.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Networks } from '@stellar/stellar-sdk';
import { ConfigError } from '../errors.js';
import { DEFAULT_GENERATOR_OPTIONS, type GeneratorOptions } from '../generate/arbitraries.js';

/** Names of the built-in checks. */
export const CHECK_NAMES = [
  'no-unexpected-trap',
  'deterministic',
  'read-only',
  'budget',
  'cost-regression',
  'custom-property',
] as const;

/** A built-in check name. */
export type CheckName = (typeof CHECK_NAMES)[number];

/** Resource thresholds for the `budget` check. */
export interface BudgetThresholds {
  /** Maximum CPU instructions per invocation. */
  cpuInstructions?: number;
  /** Maximum memory bytes per invocation. */
  memoryBytes?: number;
}

/** Per-function overrides. */
export interface FunctionConfig {
  /** Do not test this function at all. Default `false`. */
  skip?: boolean;
  /** Enable (`true`) or disable (`false`) individual checks for this function. */
  checks?: Partial<Record<CheckName, boolean>>;
  /** The function must not write state; enables the `read-only` check. Default `false`. */
  readOnly?: boolean;
  /** Budget thresholds for this function (override the global `budget`). */
  budget?: BudgetThresholds;
}

/** Cost baseline settings. */
export interface BaselineConfig {
  /** Path of the baseline file. Default `.soroban-testkit/baseline.json`. */
  path: string;
  /** Allowed growth in percent before `cost-regression` fails. Default `10`. */
  thresholdPercent: number;
}

/** Known network presets. */
export type NetworkPreset = 'testnet' | 'futurenet' | 'mainnet' | 'local';

/** User-facing configuration (every field optional). */
export interface UserConfig {
  /** Network preset that fills in `rpcUrl` and `networkPassphrase`. */
  network?: NetworkPreset;
  /** Stellar RPC URL. Env: `STELLAR_RPC_URL`. */
  rpcUrl?: string;
  /** Network passphrase. Env: `STELLAR_NETWORK_PASSPHRASE`. */
  networkPassphrase?: string;
  /** Source account (G...) for simulated transactions. Env: `STELLAR_SOURCE_ACCOUNT`. */
  sourceAccount?: string;
  /** Contract to call when the target is a local `.wasm` / `.json` file. */
  contractId?: string;
  /** Random cases per function per check (boundary cases run in addition). Default 100. */
  runs?: number;
  /** Seed for generation. Default: random, always printed. */
  seed?: number;
  /** Per-request RPC timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Retries for transport failures. Default 2. */
  retries?: number;
  /** Directory replay files are written to. Default `.soroban-testkit/replays`. */
  replayDir?: string;
  /** Input generation tunables. */
  generators?: Partial<GeneratorOptions>;
  /** Globally enable/disable checks. All default to `true`. */
  checks?: Partial<Record<CheckName, boolean>>;
  /** Global budget thresholds for the `budget` check (unset = no limit). */
  budget?: BudgetThresholds;
  /** Cost baseline settings. */
  baseline?: Partial<BaselineConfig>;
  /** Files exporting custom properties (resolved relative to the config file). */
  properties?: string[];
  /** Per-function overrides, keyed by function name. */
  functions?: Record<string, FunctionConfig>;
}

/** Fully resolved configuration. */
export interface ResolvedConfig {
  rpcUrl: string | undefined;
  networkPassphrase: string;
  sourceAccount: string | undefined;
  contractId: string | undefined;
  runs: number;
  seed: number | undefined;
  timeoutMs: number;
  retries: number;
  replayDir: string;
  generators: GeneratorOptions;
  checks: Record<CheckName, boolean>;
  budget: BudgetThresholds;
  baseline: BaselineConfig;
  properties: string[];
  functions: Record<string, FunctionConfig>;
  /** Absolute path of the loaded config file, if any. */
  configFile: string | undefined;
}

/** Network presets: RPC URL and passphrase. */
export const NETWORK_PRESETS: Record<
  NetworkPreset,
  { rpcUrl?: string; networkPassphrase: string }
> = {
  testnet: { rpcUrl: 'https://soroban-testnet.stellar.org', networkPassphrase: Networks.TESTNET },
  futurenet: { rpcUrl: 'https://rpc-futurenet.stellar.org', networkPassphrase: Networks.FUTURENET },
  mainnet: { networkPassphrase: Networks.PUBLIC },
  local: { rpcUrl: 'http://localhost:8000/rpc', networkPassphrase: Networks.STANDALONE },
};

/** Environment variables read by the tool. */
export const ENV_VARS = {
  rpcUrl: 'STELLAR_RPC_URL',
  networkPassphrase: 'STELLAR_NETWORK_PASSPHRASE',
  sourceAccount: 'STELLAR_SOURCE_ACCOUNT',
} as const;

/** Config file names searched for (in this order) in the working directory. */
export const CONFIG_FILE_NAMES = [
  'soroban-testkit.config.ts',
  'soroban-testkit.config.mjs',
  'soroban-testkit.config.js',
  'soroban-testkit.config.json',
];

/** Default values. */
export const DEFAULTS = {
  runs: 100,
  timeoutMs: 30_000,
  retries: 2,
  replayDir: '.soroban-testkit/replays',
  baseline: { path: '.soroban-testkit/baseline.json', thresholdPercent: 10 },
} as const;

/**
 * Every documented config key, as a dotted path. Used by `make docs-check`
 * to verify `docs/configuration.md` covers the whole schema.
 */
export const CONFIG_KEYS = [
  'network',
  'rpcUrl',
  'networkPassphrase',
  'sourceAccount',
  'contractId',
  'runs',
  'seed',
  'timeoutMs',
  'retries',
  'replayDir',
  'generators.maxCollectionLength',
  'generators.maxStringLength',
  'generators.maxBytesLength',
  'generators.addresses',
  'generators.maxDepth',
  'generators.maxBoundaryCases',
  'checks',
  'budget.cpuInstructions',
  'budget.memoryBytes',
  'baseline.path',
  'baseline.thresholdPercent',
  'properties',
  'functions',
  'functions.<name>.skip',
  'functions.<name>.checks',
  'functions.<name>.readOnly',
  'functions.<name>.budget',
] as const;

/** Identity helper giving type-checking and editor completion in `soroban-testkit.config.ts`. */
export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

// ---------------------------------------------------------------------------
// validation

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function allowKeys(o: Obj, keys: readonly string[], path: string): void {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) {
      throw new ConfigError(`unknown config option "${path}${k}" (allowed: ${keys.join(', ')})`);
    }
  }
}

function posInt(v: unknown, path: string, min = 1): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw new ConfigError(`"${path}" must be an integer >= ${min}, got ${JSON.stringify(v)}`);
  }
  return v;
}

function optStr(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v === '')
    throw new ConfigError(`"${path}" must be a non-empty string`);
  return v;
}

function checksMap(v: unknown, path: string): Partial<Record<CheckName, boolean>> | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) throw new ConfigError(`"${path}" must be an object of check name -> boolean`);
  allowKeys(v, CHECK_NAMES, `${path}.`);
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== 'boolean') throw new ConfigError(`"${path}.${k}" must be true or false`);
  }
  return v as Partial<Record<CheckName, boolean>>;
}

function budget(v: unknown, path: string): BudgetThresholds | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) throw new ConfigError(`"${path}" must be an object`);
  allowKeys(v, ['cpuInstructions', 'memoryBytes'], `${path}.`);
  const out: BudgetThresholds = {};
  const cpu = posInt(v.cpuInstructions, `${path}.cpuInstructions`);
  const mem = posInt(v.memoryBytes, `${path}.memoryBytes`);
  if (cpu !== undefined) out.cpuInstructions = cpu;
  if (mem !== undefined) out.memoryBytes = mem;
  return out;
}

/**
 * Validates an untrusted config object.
 *
 * @throws {@link ConfigError} describing the first problem found
 */
export function validateConfig(raw: unknown): UserConfig {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) throw new ConfigError('config must be an object');
  allowKeys(
    raw,
    [
      'network',
      'rpcUrl',
      'networkPassphrase',
      'sourceAccount',
      'contractId',
      'runs',
      'seed',
      'timeoutMs',
      'retries',
      'replayDir',
      'generators',
      'checks',
      'budget',
      'baseline',
      'properties',
      'functions',
      '$schema',
    ],
    '',
  );
  const cfg: UserConfig = {};
  if (raw.network !== undefined) {
    if (typeof raw.network !== 'string' || !(raw.network in NETWORK_PRESETS)) {
      throw new ConfigError(`"network" must be one of ${Object.keys(NETWORK_PRESETS).join(', ')}`);
    }
    cfg.network = raw.network as NetworkPreset;
  }
  const strs = ['rpcUrl', 'networkPassphrase', 'sourceAccount', 'contractId', 'replayDir'] as const;
  for (const k of strs) {
    const s = optStr(raw[k], k);
    if (s !== undefined) cfg[k] = s;
  }
  const runs = posInt(raw.runs, 'runs', 0);
  if (runs !== undefined) cfg.runs = runs;
  const seed = posInt(raw.seed, 'seed', 0);
  if (seed !== undefined) {
    if (seed > 0xffffffff) throw new ConfigError('"seed" must fit in 32 bits');
    cfg.seed = seed;
  }
  const timeoutMs = posInt(raw.timeoutMs, 'timeoutMs');
  if (timeoutMs !== undefined) cfg.timeoutMs = timeoutMs;
  const retries = posInt(raw.retries, 'retries', 0);
  if (retries !== undefined) cfg.retries = retries;

  if (raw.generators !== undefined) {
    if (!isObj(raw.generators)) throw new ConfigError('"generators" must be an object');
    const g = raw.generators;
    allowKeys(g, Object.keys(DEFAULT_GENERATOR_OPTIONS), 'generators.');
    const gen: Partial<GeneratorOptions> = {};
    for (const k of [
      'maxCollectionLength',
      'maxStringLength',
      'maxBytesLength',
      'maxDepth',
      'maxBoundaryCases',
    ] as const) {
      const n = posInt(g[k], `generators.${k}`, k === 'maxDepth' ? 0 : 1);
      if (n !== undefined) gen[k] = n;
    }
    if (g.addresses !== undefined) {
      if (
        !Array.isArray(g.addresses) ||
        !g.addresses.every((a) => typeof a === 'string' && /^[GC][A-Z2-7]{55}$/.test(a))
      ) {
        throw new ConfigError('"generators.addresses" must be an array of G... or C... strkeys');
      }
      gen.addresses = g.addresses as string[];
    }
    cfg.generators = gen;
  }
  const checks = checksMap(raw.checks, 'checks');
  if (checks) cfg.checks = checks;
  const b = budget(raw.budget, 'budget');
  if (b) cfg.budget = b;
  if (raw.baseline !== undefined) {
    if (!isObj(raw.baseline)) throw new ConfigError('"baseline" must be an object');
    allowKeys(raw.baseline, ['path', 'thresholdPercent'], 'baseline.');
    const bl: Partial<BaselineConfig> = {};
    const p = optStr(raw.baseline.path, 'baseline.path');
    if (p) bl.path = p;
    const t = raw.baseline.thresholdPercent;
    if (t !== undefined) {
      if (typeof t !== 'number' || !(t >= 0))
        throw new ConfigError('"baseline.thresholdPercent" must be a number >= 0');
      bl.thresholdPercent = t;
    }
    cfg.baseline = bl;
  }
  if (raw.properties !== undefined) {
    if (!Array.isArray(raw.properties) || !raw.properties.every((p) => typeof p === 'string')) {
      throw new ConfigError('"properties" must be an array of file paths');
    }
    cfg.properties = raw.properties as string[];
  }
  if (raw.functions !== undefined) {
    if (!isObj(raw.functions))
      throw new ConfigError('"functions" must be an object keyed by function name');
    const fns: Record<string, FunctionConfig> = {};
    for (const [name, f] of Object.entries(raw.functions)) {
      const path = `functions.${name}`;
      if (!isObj(f)) throw new ConfigError(`"${path}" must be an object`);
      allowKeys(f, ['skip', 'checks', 'readOnly', 'budget'], `${path}.`);
      const fc: FunctionConfig = {};
      for (const k of ['skip', 'readOnly'] as const) {
        if (f[k] !== undefined) {
          if (typeof f[k] !== 'boolean')
            throw new ConfigError(`"${path}.${k}" must be true or false`);
          fc[k] = f[k];
        }
      }
      const c = checksMap(f.checks, `${path}.checks`);
      if (c) fc.checks = c;
      const fb = budget(f.budget, `${path}.budget`);
      if (fb) fc.budget = fb;
      fns[name] = fc;
    }
    cfg.functions = fns;
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// loading

/** Finds a config file in `cwd` (see {@link CONFIG_FILE_NAMES}). */
export function findConfigFile(cwd: string): string | undefined {
  for (const name of CONFIG_FILE_NAMES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Imports a JS or TS module (TypeScript is compiled on the fly with `tsx`).
 * Returns its default export, or the module namespace if there is none.
 */
export async function importModule(path: string): Promise<unknown> {
  const url = pathToFileURL(path).href;
  const ext = extname(path);
  let mod: Record<string, unknown>;
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
    const { tsImport } = await import('tsx/esm/api');
    mod = (await tsImport(url, import.meta.url)) as Record<string, unknown>;
  } else {
    mod = (await import(url)) as Record<string, unknown>;
  }
  let value: unknown = 'default' in mod ? mod.default : mod;
  // tsx may wrap CommonJS-style default exports twice.
  if (value && typeof value === 'object' && 'default' in value && Object.keys(value).length === 1) {
    value = (value as { default: unknown }).default;
  }
  return value;
}

/** Reads and validates a config file (`.ts`, `.mjs`, `.js` or `.json`). */
export async function loadConfigFile(path: string): Promise<UserConfig> {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new ConfigError(`config file not found: ${path}`);
  let raw: unknown;
  try {
    if (extname(abs) === '.json') raw = JSON.parse(await readFile(abs, 'utf8'));
    else raw = await importModule(abs);
  } catch (err) {
    throw new ConfigError(`cannot load config ${path}: ${(err as Error).message}`, { cause: err });
  }
  return validateConfig(raw);
}

/** Values that override the config file (CLI flags, already parsed). */
export type ConfigOverrides = Partial<
  Pick<
    UserConfig,
    'network' | 'rpcUrl' | 'networkPassphrase' | 'sourceAccount' | 'contractId' | 'runs' | 'seed'
  >
> & { baselinePath?: string; thresholdPercent?: number };

/**
 * Merges defaults, network preset, config file, environment and CLI overrides.
 *
 * @param file - validated config file contents
 * @param configFile - absolute path of the config file (relative paths in it resolve against its directory)
 * @param env - environment (normally `process.env`)
 * @param overrides - CLI flags
 * @param cwd - working directory
 */
export function resolveConfig(
  file: UserConfig,
  configFile: string | undefined,
  env: Record<string, string | undefined>,
  overrides: ConfigOverrides = {},
  cwd: string = process.cwd(),
): ResolvedConfig {
  const network = overrides.network ?? file.network;
  const preset = network ? NETWORK_PRESETS[network] : undefined;
  const base = configFile ? dirname(configFile) : cwd;
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(base, p));
  const pick = <T>(...vals: (T | undefined)[]): T | undefined =>
    vals.find((v) => v !== undefined && v !== '');

  const checks = Object.fromEntries(
    CHECK_NAMES.map((c) => [c, file.checks?.[c] ?? true]),
  ) as Record<CheckName, boolean>;
  const cfg: ResolvedConfig = {
    rpcUrl: pick(overrides.rpcUrl, env[ENV_VARS.rpcUrl], file.rpcUrl, preset?.rpcUrl),
    networkPassphrase:
      pick(
        overrides.networkPassphrase,
        env[ENV_VARS.networkPassphrase],
        file.networkPassphrase,
        preset?.networkPassphrase,
      ) ?? Networks.STANDALONE,
    sourceAccount: pick(overrides.sourceAccount, env[ENV_VARS.sourceAccount], file.sourceAccount),
    contractId: pick(overrides.contractId, file.contractId),
    runs: overrides.runs ?? file.runs ?? DEFAULTS.runs,
    seed: overrides.seed ?? file.seed,
    timeoutMs: file.timeoutMs ?? DEFAULTS.timeoutMs,
    retries: file.retries ?? DEFAULTS.retries,
    replayDir: abs(file.replayDir ?? DEFAULTS.replayDir),
    generators: { ...DEFAULT_GENERATOR_OPTIONS, ...file.generators },
    checks,
    budget: file.budget ?? {},
    baseline: {
      path: overrides.baselinePath
        ? resolve(cwd, overrides.baselinePath)
        : abs(file.baseline?.path ?? DEFAULTS.baseline.path),
      thresholdPercent:
        overrides.thresholdPercent ??
        file.baseline?.thresholdPercent ??
        DEFAULTS.baseline.thresholdPercent,
    },
    properties: (file.properties ?? []).map(abs),
    functions: file.functions ?? {},
    configFile,
  };
  return cfg;
}

/**
 * Loads configuration the way the CLI does: an explicit `--config` path, or
 * the first {@link CONFIG_FILE_NAMES} match in `cwd`, merged with env and flags.
 */
export async function loadConfig(options: {
  configPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  overrides?: ConfigOverrides;
}): Promise<ResolvedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const path = options.configPath ? resolve(cwd, options.configPath) : findConfigFile(cwd);
  const file = path ? await loadConfigFile(path) : {};
  return resolveConfig(file, path, options.env ?? process.env, options.overrides, cwd);
}

/** Is `check` enabled for function `fn`? (per-function override, then global). */
export function checkEnabled(cfg: ResolvedConfig, fn: string, check: CheckName): boolean {
  const per = cfg.functions[fn]?.checks?.[check];
  if (per !== undefined) return per;
  return cfg.checks[check];
}

/** Effective budget thresholds for a function. */
export function budgetFor(cfg: ResolvedConfig, fn: string): BudgetThresholds {
  return { ...cfg.budget, ...cfg.functions[fn]?.budget };
}
