/**
 * Cost statistics, baseline snapshot files, and regression comparison.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigError } from '../errors.js';
import type { Resources } from '../rpc/outcome.js';

/** Min / max / mean of one metric over all successful samples. */
export interface MetricStats {
  min: number;
  max: number;
  mean: number;
}

/** Cost statistics of one function. */
export interface FunctionCosts {
  /** Number of successful simulations measured. */
  samples: number;
  cpuInstructions: MetricStats;
  /** `null` when the RPC does not report memory. */
  memoryBytes: MetricStats | null;
  /** Largest minimum resource fee seen, in stroops. */
  maxMinResourceFee: string;
  /** Largest write footprint seen (entries). */
  maxWriteEntries: number;
  /** The input that used the most CPU, rendered as `name=value, ...`. */
  costliestInput: string;
}

/** Contents of a baseline file. */
export interface BaselineFile {
  version: 1;
  generator: 'soroban-testkit';
  createdAt: string;
  /** Contract the baseline was measured on. */
  contractId?: string;
  /** Seed used to generate the measured inputs. `costs --check-baseline` reuses it. */
  seed: number;
  /** Random runs per function used for the measurement. */
  runs: number;
  functions: Record<string, FunctionCosts>;
}

/** A cost metric compared against the baseline. */
export type CostMetric = 'cpuInstructions' | 'memoryBytes';

/** One metric of one function, compared with the baseline. */
export interface CostDelta {
  function: string;
  metric: CostMetric;
  baseline: number;
  current: number;
  /** Relative change in percent (positive = more expensive). */
  changePercent: number;
}

/** Result of comparing current costs with a baseline. */
export interface BaselineComparison {
  thresholdPercent: number;
  /** Metrics that grew by more than the threshold. */
  regressions: CostDelta[];
  /** Metrics that shrank by more than the threshold. */
  improvements: CostDelta[];
  /** Functions measured now but absent from the baseline. */
  newFunctions: string[];
  /** Functions in the baseline that were not measured now. */
  missingFunctions: string[];
}

function stats(values: number[]): MetricStats {
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: Math.round(sum / values.length),
  };
}

/**
 * Aggregates the resources of successful samples.
 *
 * @returns `null` when there is no successful sample
 */
export function computeCosts(
  samples: ReadonlyArray<{ resources: Resources; input: string }>,
): FunctionCosts | null {
  if (samples.length === 0) return null;
  const cpu = samples.map((s) => s.resources.cpuInstructions);
  const mem = samples.map((s) => s.resources.memoryBytes);
  let costliest = samples[0]!;
  for (const s of samples)
    if (s.resources.cpuInstructions > costliest.resources.cpuInstructions) costliest = s;
  const fees = samples.map((s) => BigInt(s.resources.minResourceFee));
  return {
    samples: samples.length,
    cpuInstructions: stats(cpu),
    memoryBytes: mem.every((m): m is number => m !== null) ? stats(mem) : null,
    maxMinResourceFee: fees.reduce((a, b) => (b > a ? b : a), 0n).toString(),
    maxWriteEntries: Math.max(...samples.map((s) => s.resources.writeEntries)),
    costliestInput: costliest.input,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compares the `max` of each metric against the baseline.
 *
 * A metric regresses when `(current - baseline) / baseline * 100 > thresholdPercent`.
 */
export function compareCosts(
  baseline: Record<string, FunctionCosts>,
  current: Record<string, FunctionCosts>,
  thresholdPercent: number,
): BaselineComparison {
  const out: BaselineComparison = {
    thresholdPercent,
    regressions: [],
    improvements: [],
    newFunctions: Object.keys(current)
      .filter((f) => !(f in baseline))
      .sort(),
    missingFunctions: Object.keys(baseline)
      .filter((f) => !(f in current))
      .sort(),
  };
  for (const [fn, cur] of Object.entries(current)) {
    const base = baseline[fn];
    if (!base) continue;
    for (const metric of ['cpuInstructions', 'memoryBytes'] as const) {
      const b = base[metric]?.max;
      const c = cur[metric]?.max;
      if (b === undefined || c === undefined) continue;
      const changePercent = b === 0 ? (c === 0 ? 0 : Infinity) : round2(((c - b) / b) * 100);
      const delta: CostDelta = { function: fn, metric, baseline: b, current: c, changePercent };
      if (changePercent > thresholdPercent) out.regressions.push(delta);
      else if (changePercent < -thresholdPercent) out.improvements.push(delta);
    }
  }
  return out;
}

/** Reads a baseline file, or returns `undefined` if it does not exist. */
export async function readBaseline(path: string): Promise<BaselineFile | undefined> {
  if (!existsSync(path)) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`baseline ${path} is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const b = doc as Partial<BaselineFile>;
  if (
    !b ||
    b.version !== 1 ||
    typeof b.functions !== 'object' ||
    b.functions === null ||
    typeof b.seed !== 'number' ||
    typeof b.runs !== 'number'
  ) {
    throw new ConfigError(`baseline ${path} is not a soroban-testkit v1 baseline file`);
  }
  return b as BaselineFile;
}

/** Writes a baseline file (creating parent directories). */
export async function writeBaseline(path: string, baseline: BaselineFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(baseline, null, 2) + '\n');
}
