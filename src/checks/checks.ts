/**
 * Built-in checks evaluated on every simulated invocation.
 *
 * `cost-regression` is evaluated per function over all samples and lives in
 * `src/baseline/`.
 */
import { xdr } from '@stellar/stellar-sdk';
import { TestkitError } from '../errors.js';
import { budgetFor, checkEnabled, type CheckName, type ResolvedConfig } from '../config/config.js';
import { fromScVal } from '../generate/scval.js';
import { formatValue } from '../generate/format.js';
import type { Outcome, Resources, SimulationResult } from '../rpc/outcome.js';
import type { ContractSpec, FunctionSpec } from '../spec/types.js';
import { propertyApplies, type CallResult, type Property } from './properties.js';

/** One simulated call. */
export interface Invocation {
  fn: FunctionSpec;
  /** Native argument values. */
  args: unknown[];
  /** Base64 XDR of each argument `ScVal`. */
  argsXdr: string[];
  result: SimulationResult;
}

/** A check failure for one input. */
export interface Violation {
  /** One-line explanation. */
  message: string;
  /** Structured details (JSON-safe). */
  details?: Record<string, unknown>;
}

/** Services available to checks. */
export interface CaseCheckContext {
  spec: ContractSpec;
  /** Simulates the same invocation again, bypassing any cache. */
  reinvoke(): Promise<SimulationResult>;
  /** Simulates another function of the same contract (used by custom properties). */
  call?(fn: string, args?: Record<string, unknown> | unknown[]): Promise<CallResult>;
}

/** A check evaluated on each invocation. */
export interface CaseCheck {
  check: CheckName;
  /** Distinguishes multiple instances of one check (property name for custom properties). */
  label?: string;
  /** Returns a violation, or `null` if the invocation passes. */
  evaluate(inv: Invocation, ctx: CaseCheckContext): Promise<Violation | null>;
}

/** Fails when the invocation traps (declared contract errors are fine). */
export const noUnexpectedTrap: CaseCheck = {
  check: 'no-unexpected-trap',
  async evaluate(inv) {
    const o = inv.result.outcome;
    if (o.kind !== 'trap') return null;
    return {
      message: `trapped with Error(${o.error})`,
      details: { error: o.error, ...(o.detail ? { hostDetail: o.detail } : {}) },
    };
  },
};

function outcomeKey(o: Outcome): string {
  switch (o.kind) {
    case 'success':
      return `success:${o.retvalXdr}`;
    case 'contract-error':
      return `contract-error:${o.code}`;
    case 'trap':
      return `trap:${o.error}`;
    case 'simulation-failed':
      return `simulation-failed:${o.message}`;
  }
}

function describeOutcome(o: Outcome, inv: Invocation, spec: ContractSpec): string {
  switch (o.kind) {
    case 'success': {
      const t = inv.fn.outputs[0] ?? { kind: 'void' as const };
      return `returned ${formatValue(fromScVal(t, xdr.ScVal.fromXdr(o.retvalXdr, 'base64'), spec))}`;
    }
    case 'contract-error':
      return `failed with ${o.name} (#${o.code})`;
    case 'trap':
      return `trapped with Error(${o.error})`;
    case 'simulation-failed':
      return `simulation failed: ${o.message}`;
  }
}

const COMPARED_RESOURCES: (keyof Resources)[] = [
  'cpuInstructions',
  'memoryBytes',
  'readEntries',
  'writeEntries',
  'readBytes',
  'writeBytes',
];

/**
 * Simulates the same input a second time and fails if the outcome, return
 * value, or resource numbers differ. The resource fee is not compared: it
 * depends on network fee settings that may change between ledgers.
 */
export const deterministic: CaseCheck = {
  check: 'deterministic',
  async evaluate(inv, ctx) {
    const first = inv.result;
    if (first.outcome.kind === 'simulation-failed') return null;
    const second = await ctx.reinvoke();
    if (second.outcome.kind === 'simulation-failed') return null;
    if (outcomeKey(first.outcome) !== outcomeKey(second.outcome)) {
      return {
        message: 'two simulations of the same input gave different results',
        details: {
          first: describeOutcome(first.outcome, inv, ctx.spec),
          second: describeOutcome(second.outcome, inv, ctx.spec),
        },
      };
    }
    if (first.resources && second.resources) {
      const diffs = COMPARED_RESOURCES.filter(
        (k) => first.resources![k] !== second.resources![k],
      ).map((k) => `${k} ${String(first.resources![k])} -> ${String(second.resources![k])}`);
      if (diffs.length > 0) {
        return {
          message: 'two simulations of the same input used different resources',
          details: { diffs },
        };
      }
    }
    return null;
  },
};

/** Renders a base64 `LedgerKey` for humans. */
export function describeLedgerKey(b64: string): string {
  try {
    const json = xdr.LedgerKey.fromXdr(b64, 'base64').toJson() as Record<
      string,
      Record<string, unknown>
    >;
    const cd = json.contract_data;
    if (cd) {
      const key = cd.key === 'ledger_key_contract_instance' ? 'instance' : JSON.stringify(cd.key);
      return `${String(cd.durability)} contract data ${key}`;
    }
    return JSON.stringify(json);
  } catch {
    return b64;
  }
}

/** Fails when a successful call has a non-empty read-write footprint. */
export const readOnly: CaseCheck = {
  check: 'read-only',
  async evaluate(inv) {
    const r = inv.result.resources;
    if (inv.result.outcome.kind !== 'success' || !r || r.writeEntries === 0) return null;
    const keys = r.writeFootprint.map(describeLedgerKey);
    return {
      message: `function is configured read-only but writes ${r.writeEntries} ledger entr${r.writeEntries === 1 ? 'y' : 'ies'}: ${keys.join('; ')}`,
      details: { writeEntries: r.writeEntries, writeBytes: r.writeBytes, keys },
    };
  },
};

/** Builds the `budget` check for given thresholds. */
export function budgetCheck(limits: { cpuInstructions?: number; memoryBytes?: number }): CaseCheck {
  return {
    check: 'budget',
    async evaluate(inv) {
      const r = inv.result.resources;
      if (!r) return null;
      const over: string[] = [];
      if (limits.cpuInstructions !== undefined && r.cpuInstructions > limits.cpuInstructions) {
        over.push(`CPU ${r.cpuInstructions} > ${limits.cpuInstructions} instructions`);
      }
      if (
        limits.memoryBytes !== undefined &&
        r.memoryBytes !== null &&
        r.memoryBytes > limits.memoryBytes
      ) {
        over.push(`memory ${r.memoryBytes} > ${limits.memoryBytes} bytes`);
      }
      if (over.length === 0) return null;
      return {
        message: `over budget: ${over.join(', ')}`,
        details: { cpuInstructions: r.cpuInstructions, memoryBytes: r.memoryBytes, limits },
      };
    },
  };
}

/** Builds a `custom-property` check for one user property. */
export function propertyCheck(p: Property): CaseCheck {
  return {
    check: 'custom-property',
    label: p.name,
    async evaluate(inv, ctx) {
      const o = inv.result.outcome;
      if (o.kind === 'simulation-failed') return null;
      if (o.kind !== 'success' && !p.includeFailures) return null;
      const args = Object.fromEntries(inv.fn.inputs.map((input, i) => [input.name, inv.args[i]]));
      let result: unknown;
      if (o.kind === 'success') {
        const t = inv.fn.outputs[0] ?? { kind: 'void' as const };
        result = fromScVal(t, xdr.ScVal.fromXdr(o.retvalXdr, 'base64'), ctx.spec);
      }
      let verdict: unknown;
      try {
        verdict = await p.check(args, result, {
          function: inv.fn.name,
          outcome: o,
          resources: inv.result.resources,
          call: async (fn, callArgs) => {
            if (!ctx.call) throw new Error('ctx.call is not available here');
            return ctx.call(fn, callArgs);
          },
        });
      } catch (err) {
        // Tool errors (RPC down, bad config) abort the run; they are never findings.
        if (err instanceof TestkitError) throw err;
        return {
          message: `property "${p.name}" threw: ${(err as Error)?.message ?? String(err)}`,
          details: { property: p.name, result: formatValue(result) },
        };
      }
      if (verdict === false || typeof verdict === 'string') {
        const why = typeof verdict === 'string' ? verdict : 'returned false';
        return {
          message: `property "${p.name}" failed: ${why} (result: ${formatValue(result)})`,
          details: { property: p.name, result: formatValue(result) },
        };
      }
      return null;
    },
  };
}

/** The per-invocation checks that apply to a function under a config. */
export function caseChecksFor(
  fn: FunctionSpec,
  cfg: ResolvedConfig,
  properties: readonly Property[],
): CaseCheck[] {
  const out: CaseCheck[] = [];
  const on = (c: CheckName): boolean => checkEnabled(cfg, fn.name, c);
  if (on('no-unexpected-trap')) out.push(noUnexpectedTrap);
  if (on('deterministic')) out.push(deterministic);
  if (on('read-only') && cfg.functions[fn.name]?.readOnly) out.push(readOnly);
  const limits = budgetFor(cfg, fn.name);
  if (on('budget') && (limits.cpuInstructions !== undefined || limits.memoryBytes !== undefined)) {
    out.push(budgetCheck(limits));
  }
  if (on('custom-property')) {
    for (const p of properties) if (propertyApplies(p, fn.name)) out.push(propertyCheck(p));
  }
  return out;
}
