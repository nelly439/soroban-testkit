/**
 * Orchestration: for every function, generate inputs (boundary values first,
 * then seeded random values), simulate them, evaluate the checks, shrink
 * failures with fast-check, and collect cost statistics.
 */
import fc from 'fast-check';
import { xdr } from '@stellar/stellar-sdk';
import { checkEnabled, type CheckName, type ResolvedConfig } from '../config/config.js';
import { UsageError } from '../errors.js';
import { argumentsArbitrary, boundaryCases } from '../generate/arbitraries.js';
import { formatArgs, toJsonSafe, type JsonSafe } from '../generate/format.js';
import { argsToScVals, fromScVal } from '../generate/scval.js';
import type { SimulationResult } from '../rpc/outcome.js';
import { declaredErrorCodes, type ContractSpec, type FunctionSpec } from '../spec/types.js';
import {
  caseChecksFor,
  type CaseCheck,
  type Invocation,
  type Violation,
} from '../checks/checks.js';
import type { CallResult, Property } from '../checks/properties.js';
import {
  compareCosts,
  computeCosts,
  type BaselineComparison,
  type BaselineFile,
  type FunctionCosts,
} from '../baseline/baseline.js';
import { writeReplay, type ReplayFile } from './replay.js';
import { displayPath } from '../report/reporters.js';
import { VERSION } from '../version.js';

/** Anything that can simulate an invocation (normally {@link SimulationClient}). */
export interface Simulator {
  simulate(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
    declared: ReadonlyMap<number, string>,
  ): Promise<SimulationResult>;
}

/** A minimal failing input. */
export interface Counterexample {
  /** Arguments keyed by parameter name (JSON-safe: bigints as `{"$bigint"}`, bytes as `{"$bytes"}`). */
  args: Record<string, JsonSafe>;
  /** Human-readable `name=value, ...`. */
  display: string;
  /** Base64 XDR `ScVal` of each argument. */
  argsXdr: string[];
}

/** A problem reported by a check. */
export interface Finding {
  check: CheckName;
  function: string;
  /** Property name for `custom-property` findings. */
  property?: string;
  message: string;
  counterexample: Counterexample;
  /** Whether the counterexample came out of shrinking (false for `cost-regression`, which reports the costliest input). */
  shrunk: boolean;
  /** Number of successful shrink steps. */
  shrinkSteps: number;
  /** Seed of the run that found it. */
  seed: number;
  details?: Record<string, JsonSafe>;
  /** Path of the replay file, if written. */
  replayFile?: string;
}

/** Outcome counts over distinct simulated inputs. */
export interface OutcomeCounts {
  success: number;
  contractError: number;
  trap: number;
  simulationFailed: number;
}

/** Per-function summary. */
export interface FunctionSummary {
  name: string;
  /** Check (or property) names evaluated. */
  checks: string[];
  /** Distinct inputs simulated. */
  inputs: number;
  outcomes: OutcomeCounts;
  /** Cost statistics over the measurement set (boundary + seeded random inputs). */
  costs: FunctionCosts | null;
  /** Why the function was skipped, if it was. */
  skipped?: string;
}

/** Everything a run produced. */
export interface RunReport {
  tool: { name: 'soroban-testkit'; version: string };
  mode: 'fuzz' | 'costs' | 'replay';
  contractId: string;
  seed: number;
  runs: number;
  startedAt: string;
  durationMs: number;
  findings: Finding[];
  functions: FunctionSummary[];
  /** Total `simulateTransaction` calls. */
  simulations: number;
  /** Up to 20 examples of simulations that failed for non-contract reasons. */
  simulationFailures: Array<{ function: string; input: string; message: string }>;
  /** Baseline comparison, when a baseline was used. */
  baseline?: { path: string; seed: number; runs: number; comparison: BaselineComparison };
  /** Informational notes (skipped checks, partial failures, ...). */
  notes: string[];
}

/** Progress events emitted while running. */
export type RunEvent =
  | { type: 'function-start'; function: string; checks: string[] }
  | { type: 'finding'; finding: Finding }
  | { type: 'function-done'; function: string; summary: FunctionSummary };

/** Options for {@link run}. */
export interface RunOptions {
  spec: ContractSpec;
  contractId: string;
  simulator: Simulator;
  config: ResolvedConfig;
  /** Seed for all generation (32-bit unsigned). */
  seed: number;
  /** Random cases per function (boundary cases run in addition). */
  runs: number;
  /** Custom properties. */
  properties?: Property[];
  /** Baseline for `cost-regression` (both modes). */
  baseline?: { path: string; file: BaselineFile };
  /** Only test these functions. */
  functions?: string[];
  /** `fuzz` runs all checks; `costs` only measures costs. Default `fuzz`. */
  mode?: 'fuzz' | 'costs';
  /** Write replay files for findings into `config.replayDir`. Default true. */
  writeReplays?: boolean;
  onEvent?: (event: RunEvent) => void;
}

interface FunctionState {
  fn: FunctionSpec;
  cache: Map<string, Promise<SimulationResult>>;
  inputs: Map<string, unknown[]>;
}

/** Thrown inside fast-check properties to abort the whole run. */
class Abort {
  constructor(readonly error: unknown) {}
}

class Engine {
  readonly declared: ReadonlyMap<number, string>;
  simulations = 0;
  readonly failures: RunReport['simulationFailures'] = [];

  constructor(
    readonly spec: ContractSpec,
    readonly contractId: string,
    readonly simulator: Simulator,
  ) {
    this.declared = declaredErrorCodes(spec);
  }

  argsXdr(fn: FunctionSpec, args: unknown[]): string[] {
    return argsToScVals(
      fn.inputs.map((i) => i.type),
      args,
      this.spec,
    ).map((v) => v.toXdr('base64'));
  }

  private async fresh(
    fn: FunctionSpec,
    argsXdr: string[],
    args: unknown[],
  ): Promise<SimulationResult> {
    this.simulations++;
    const res = await this.simulator.simulate(
      this.contractId,
      fn.name,
      argsXdr.map((a) => xdr.ScVal.fromXdr(a, 'base64')),
      this.declared,
    );
    if (res.outcome.kind === 'simulation-failed' && this.failures.length < 20) {
      this.failures.push({
        function: fn.name,
        input: formatArgs(
          fn.inputs.map((i) => i.name),
          args,
        ),
        message: res.outcome.message,
      });
    }
    return res;
  }

  /** Simulates (cached by encoded arguments). */
  invoke(state: FunctionState, args: unknown[]): Promise<Invocation> {
    const argsXdr = this.argsXdr(state.fn, args);
    const key = argsXdr.join('|');
    let p = state.cache.get(key);
    if (!p) {
      p = this.fresh(state.fn, argsXdr, args);
      state.cache.set(key, p);
      state.inputs.set(key, args);
    }
    return p.then((result) => ({ fn: state.fn, args, argsXdr, result }));
  }

  /** Simulates any function of the contract by name, always fresh (for `ctx.call` in properties). */
  async call(name: string, args: Record<string, unknown> | unknown[] = {}): Promise<CallResult> {
    const fn = this.spec.functions.find((f) => f.name === name);
    if (!fn) throw new Error(`ctx.call: unknown function "${name}"`);
    const list = Array.isArray(args)
      ? args
      : fn.inputs.map((i) => {
          if (!(i.name in args))
            throw new Error(`ctx.call: missing argument "${i.name}" for ${name}`);
          return args[i.name];
        });
    const argsXdr = this.argsXdr(fn, list);
    const inv = { result: await this.fresh(fn, argsXdr, list) };
    const o = inv.result.outcome;
    const result =
      o.kind === 'success'
        ? fromScVal(
            fn.outputs[0] ?? { kind: 'void' },
            xdr.ScVal.fromXdr(o.retvalXdr, 'base64'),
            this.spec,
          )
        : undefined;
    return { outcome: o, result, resources: inv.result.resources };
  }

  /** Simulates again, bypassing the cache (for the determinism check). */
  reinvoke(fn: FunctionSpec, argsXdr: string[], args: unknown[]): Promise<SimulationResult> {
    return this.fresh(fn, argsXdr, args);
  }

  counterexample(fn: FunctionSpec, args: unknown[]): Counterexample {
    return {
      args: Object.fromEntries(fn.inputs.map((i, n) => [i.name, toJsonSafe(args[n])])),
      display: formatArgs(
        fn.inputs.map((i) => i.name),
        args,
      ),
      argsXdr: this.argsXdr(fn, args),
    };
  }

  /**
   * Runs one per-invocation check as a fast-check property. Returns the
   * shrunk finding, or null.
   */
  async runCaseCheck(
    state: FunctionState,
    check: CaseCheck,
    opts: { seed: number; runs: number; examples: unknown[][]; config: ResolvedConfig },
  ): Promise<Omit<Finding, 'seed'> | null> {
    const violations = new Map<string, Violation>();
    let abort: Abort | undefined;
    const prop = fc.asyncProperty(
      argumentsArbitrary(state.fn, this.spec, opts.config.generators),
      async (args) => {
        if (abort) return true;
        try {
          const inv = await this.invoke(state, args);
          const violation = await check.evaluate(inv, {
            spec: this.spec,
            reinvoke: () => this.reinvoke(state.fn, inv.argsXdr, args),
            call: (fn, a) => this.call(fn, a),
          });
          if (!violation) return true;
          violations.set(inv.argsXdr.join('|'), violation);
          return false;
        } catch (err) {
          abort = new Abort(err);
          return true;
        }
      },
    );
    const out = await fc.check(prop, {
      seed: opts.seed,
      numRuns: opts.examples.length + opts.runs,
      examples: opts.examples.map((e) => [e]),
    });
    if (abort) throw abort.error;
    if (!out.failed || !out.counterexample) return null;
    const args = out.counterexample[0];
    const violation = violations.get(this.argsXdr(state.fn, args).join('|')) ?? {
      message: 'check failed',
    };
    return {
      check: check.check,
      function: state.fn.name,
      ...(check.label ? { property: check.label } : {}),
      message: violation.message,
      counterexample: this.counterexample(state.fn, args),
      shrunk: true,
      shrinkSteps: out.numShrinks,
      ...(violation.details
        ? { details: toJsonSafe(violation.details) as Record<string, JsonSafe> }
        : {}),
    };
  }
}

function outcomeCounts(results: SimulationResult[]): OutcomeCounts {
  const c: OutcomeCounts = { success: 0, contractError: 0, trap: 0, simulationFailed: 0 };
  for (const r of results) {
    if (r.outcome.kind === 'success') c.success++;
    else if (r.outcome.kind === 'contract-error') c.contractError++;
    else if (r.outcome.kind === 'trap') c.trap++;
    else c.simulationFailed++;
  }
  return c;
}

/** Measures cost statistics over boundary + seeded random inputs (identical across runs with the same seed). */
async function measure(
  engine: Engine,
  state: FunctionState,
  config: ResolvedConfig,
  seed: number,
  runs: number,
): Promise<{ costs: FunctionCosts | null; costliestArgs: unknown[] | undefined }> {
  const inputs = [
    ...boundaryCases(state.fn, engine.spec, config.generators),
    ...(runs > 0
      ? fc.sample(argumentsArbitrary(state.fn, engine.spec, config.generators), {
          seed,
          numRuns: runs,
        })
      : []),
  ];
  const samples: Array<{
    resources: NonNullable<SimulationResult['resources']>;
    input: string;
    args: unknown[];
  }> = [];
  for (const args of inputs) {
    const inv = await engine.invoke(state, args);
    if (inv.result.outcome.kind === 'success' && inv.result.resources) {
      samples.push({
        resources: inv.result.resources,
        input: formatArgs(
          state.fn.inputs.map((i) => i.name),
          args,
        ),
        args,
      });
    }
  }
  const costs = computeCosts(samples);
  const costliest = costs ? samples.find((s) => s.input === costs.costliestInput)?.args : undefined;
  return { costs, costliestArgs: costliest };
}

function selectFunctions(
  spec: ContractSpec,
  config: ResolvedConfig,
  only?: string[],
): FunctionSpec[] {
  if (only && only.length > 0) {
    const unknown = only.filter((n) => !spec.functions.some((f) => f.name === n));
    if (unknown.length > 0) {
      throw new UsageError(
        `unknown function(s): ${unknown.join(', ')}. Available: ${spec.functions.map((f) => f.name).join(', ')}`,
      );
    }
  }
  return spec.functions.filter((f) => !only || only.length === 0 || only.includes(f.name));
}

function isConstructor(fn: FunctionSpec): boolean {
  return fn.name === '__constructor';
}

/**
 * Runs the checks (fuzz mode) or the cost measurement (costs mode) against a
 * contract through simulation only.
 *
 * @throws {@link RpcUnavailableError} on transport failure (never turned into a finding)
 * @throws {@link UsageError} if every simulation failed for non-contract reasons
 */
export async function run(options: RunOptions): Promise<RunReport> {
  const { spec, config, seed, runs } = options;
  const mode = options.mode ?? 'fuzz';
  const started = Date.now();
  const engine = new Engine(spec, options.contractId, options.simulator);
  const report: RunReport = {
    tool: { name: 'soroban-testkit', version: VERSION },
    mode,
    contractId: options.contractId,
    seed,
    runs,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    findings: [],
    functions: [],
    simulations: 0,
    simulationFailures: engine.failures,
    notes: [],
  };
  const properties = options.properties ?? [];
  const current: Record<string, FunctionCosts> = {};
  const costliestByFn = new Map<string, unknown[]>();

  for (const name of Object.keys(config.functions)) {
    if (!spec.functions.some((f) => f.name === name)) {
      report.notes.push(`config mentions function "${name}", which is not in the contract spec`);
    }
  }
  for (const p of properties) {
    const fns = Array.isArray(p.function) ? p.function : [p.function];
    for (const f of fns) {
      if (f !== '*' && !spec.functions.some((x) => x.name === f)) {
        report.notes.push(`property "${p.name}" targets unknown function "${f}"`);
      }
    }
  }

  const addFinding = async (f: Omit<Finding, 'seed'>): Promise<void> => {
    const finding: Finding = { ...f, seed };
    if (options.writeReplays !== false) {
      const replay: ReplayFile = {
        version: 1,
        contractId: options.contractId,
        function: f.function,
        check: f.check,
        ...(f.property ? { property: f.property } : {}),
        seed,
        runs,
        argsXdr: f.counterexample.argsXdr,
        display: f.counterexample.display,
        message: f.message,
      };
      finding.replayFile = await writeReplay(config.replayDir, replay);
    }
    report.findings.push(finding);
    options.onEvent?.({ type: 'finding', finding });
  };

  for (const fn of selectFunctions(spec, config, options.functions)) {
    const state: FunctionState = { fn, cache: new Map(), inputs: new Map() };
    const summary: FunctionSummary = {
      name: fn.name,
      checks: [],
      inputs: 0,
      outcomes: { success: 0, contractError: 0, trap: 0, simulationFailed: 0 },
      costs: null,
    };
    if (config.functions[fn.name]?.skip) {
      summary.skipped = 'skipped by config';
      report.functions.push(summary);
      continue;
    }
    if (isConstructor(fn)) {
      summary.skipped = 'constructors run only at deploy time';
      report.functions.push(summary);
      continue;
    }
    const caseChecks = mode === 'fuzz' ? caseChecksFor(fn, config, properties) : [];
    const costCheck =
      options.baseline !== undefined && checkEnabled(config, fn.name, 'cost-regression');
    summary.checks = [
      ...caseChecks.map((c) => c.label ?? c.check),
      ...(costCheck ? ['cost-regression'] : []),
    ];
    options.onEvent?.({ type: 'function-start', function: fn.name, checks: summary.checks });

    const { costs, costliestArgs } = await measure(engine, state, config, seed, runs);
    summary.costs = costs;
    if (costs) current[fn.name] = costs;
    if (costliestArgs) costliestByFn.set(fn.name, costliestArgs);

    const examples = boundaryCases(fn, spec, config.generators);
    for (const check of caseChecks) {
      const f = await engine.runCaseCheck(state, check, { seed, runs, examples, config });
      if (f) await addFinding(f);
    }

    const results = await Promise.all(state.cache.values());
    summary.inputs = results.length;
    summary.outcomes = outcomeCounts(results);
    if (summary.outcomes.simulationFailed > 0) {
      report.notes.push(
        `${fn.name}: ${summary.outcomes.simulationFailed} of ${summary.inputs} simulations failed for non-contract reasons (not counted as findings)`,
      );
    }
    report.functions.push(summary);
    options.onEvent?.({ type: 'function-done', function: fn.name, summary });
  }

  // cost-regression (function-level)
  if (options.baseline) {
    const { file, path } = options.baseline;
    const enabledFns = Object.fromEntries(
      Object.entries(current).filter(([name]) => checkEnabled(config, name, 'cost-regression')),
    );
    // With --function, only compare the selected functions.
    const baselineFns =
      options.functions && options.functions.length > 0
        ? Object.fromEntries(
            Object.entries(file.functions).filter(([n]) => options.functions!.includes(n)),
          )
        : file.functions;
    const comparison = compareCosts(baselineFns, enabledFns, config.baseline.thresholdPercent);
    report.baseline = { path, seed: file.seed, runs: file.runs, comparison };
    if (file.seed !== seed || file.runs !== runs) {
      report.notes.push(
        `baseline was measured with --seed ${file.seed} --runs ${file.runs}; this run used --seed ${seed} --runs ${runs}, so inputs differ and cost comparison is approximate`,
      );
    }
    const byFn = new Map<string, typeof comparison.regressions>();
    for (const r of comparison.regressions)
      byFn.set(r.function, [...(byFn.get(r.function) ?? []), r]);
    for (const [name, deltas] of byFn) {
      const fn = spec.functions.find((f) => f.name === name)!;
      const args = costliestByFn.get(name) ?? [];
      await addFinding({
        check: 'cost-regression',
        function: name,
        message: `cost grew beyond ${comparison.thresholdPercent}%: ${deltas
          .map(
            (d) =>
              `${d.metric === 'cpuInstructions' ? 'CPU' : 'memory'} max ${d.baseline} -> ${d.current} (+${d.changePercent}%)`,
          )
          .join(', ')}`,
        counterexample: engine.counterexample(fn, args),
        shrunk: false,
        shrinkSteps: 0,
        details: toJsonSafe({ deltas }) as Record<string, JsonSafe>,
      });
    }
  } else if (mode === 'fuzz' && config.checks['cost-regression']) {
    report.notes.push(
      `cost-regression skipped: no baseline at ${displayPath(config.baseline.path)} (create one with "soroban-testkit costs <target> --update-baseline")`,
    );
  }

  report.simulations = engine.simulations;
  report.durationMs = Date.now() - started;
  const all = report.functions.filter((f) => !f.skipped);
  const total = all.reduce((n, f) => n + f.inputs, 0);
  const failed = all.reduce((n, f) => n + f.outcomes.simulationFailed, 0);
  if (total > 0 && failed === total) {
    throw new UsageError(
      `every simulation failed for non-contract reasons (first error: ${engine.failures[0]?.message ?? 'unknown'}). ` +
        'Check the contract ID, network passphrase and source account.',
    );
  }
  return report;
}

/** Decodes replay arguments back into native values. */
export function decodeReplayArgs(
  fn: FunctionSpec,
  argsXdr: string[],
  spec: ContractSpec,
): unknown[] {
  if (argsXdr.length !== fn.inputs.length) {
    throw new UsageError(
      `replay has ${argsXdr.length} argument(s) but ${fn.name} takes ${fn.inputs.length}; was the contract interface changed?`,
    );
  }
  return fn.inputs.map((input, i) =>
    fromScVal(input.type, xdr.ScVal.fromXdr(argsXdr[i]!, 'base64'), spec),
  );
}

/** Options for {@link replay}. */
export interface ReplayOptions {
  spec: ContractSpec;
  contractId: string;
  simulator: Simulator;
  config: ResolvedConfig;
  replay: ReplayFile;
  properties?: Property[];
  baseline?: { path: string; file: BaselineFile };
}

/**
 * Re-runs exactly the recorded failing input for the recorded check. For
 * `cost-regression`, re-measures the function with the recorded seed and runs.
 * The report contains the finding again if (and only if) it reproduces.
 */
export async function replay(options: ReplayOptions): Promise<RunReport> {
  const { spec, replay: r, config } = options;
  const fn = spec.functions.find((f) => f.name === r.function);
  if (!fn) throw new UsageError(`replay function "${r.function}" is not in the contract spec`);

  if (r.check === 'cost-regression') {
    if (!options.baseline)
      throw new UsageError('replaying a cost-regression finding needs the baseline file');
    const rep = await run({
      spec,
      contractId: options.contractId,
      simulator: options.simulator,
      config: {
        ...config,
        checks: {
          ...config.checks,
          'no-unexpected-trap': false,
          deterministic: false,
          'read-only': false,
          budget: false,
          'custom-property': false,
          'cost-regression': true,
        },
      },
      seed: r.seed,
      runs: r.runs,
      baseline: options.baseline,
      functions: [fn.name],
      writeReplays: false,
    });
    return { ...rep, mode: 'replay' };
  }

  const started = Date.now();
  const engine = new Engine(spec, options.contractId, options.simulator);
  const args = decodeReplayArgs(fn, r.argsXdr, spec);
  const checks = caseChecksFor(
    fn,
    {
      ...config,
      checks: { ...config.checks, [r.check]: true },
      functions: {
        ...config.functions,
        [fn.name]: {
          ...config.functions[fn.name],
          checks: { [r.check]: true },
          ...(r.check === 'read-only' ? { readOnly: true } : {}),
        },
      },
    },
    options.properties ?? [],
  ).filter((c) => c.check === r.check && (r.property === undefined || c.label === r.property));
  if (checks.length === 0) {
    throw new UsageError(
      r.property
        ? `property "${r.property}" was not found in the configured property files`
        : `check ${r.check} cannot run for ${fn.name} with the current config (for budget, configure thresholds)`,
    );
  }
  const state: FunctionState = { fn, cache: new Map(), inputs: new Map() };
  const findings: Finding[] = [];
  for (const check of checks) {
    const inv = await engine.invoke(state, args);
    const v = await check.evaluate(inv, {
      spec,
      reinvoke: () => engine.reinvoke(fn, inv.argsXdr, args),
      call: (name, a) => engine.call(name, a),
    });
    if (v) {
      findings.push({
        check: check.check,
        function: fn.name,
        ...(check.label ? { property: check.label } : {}),
        message: v.message,
        counterexample: engine.counterexample(fn, args),
        shrunk: true,
        shrinkSteps: 0,
        seed: r.seed,
        ...(v.details ? { details: toJsonSafe(v.details) as Record<string, JsonSafe> } : {}),
      });
    }
  }
  const results = await Promise.all(state.cache.values());
  return {
    tool: { name: 'soroban-testkit', version: VERSION },
    mode: 'replay',
    contractId: options.contractId,
    seed: r.seed,
    runs: 0,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    findings,
    functions: [
      {
        name: fn.name,
        checks: checks.map((c) => c.label ?? c.check),
        inputs: results.length,
        outcomes: outcomeCounts(results),
        costs: null,
      },
    ],
    simulations: engine.simulations,
    simulationFailures: engine.failures,
    notes: [],
  };
}
