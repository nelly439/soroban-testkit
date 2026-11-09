/**
 * User-written properties for the `custom-property` check.
 */
import { ConfigError } from '../errors.js';
import { importModule } from '../config/config.js';
import type { Outcome, Resources } from '../rpc/outcome.js';

/** Result of {@link PropertyContext.call}. */
export interface CallResult {
  /** Classified outcome of the simulation. */
  outcome: Outcome;
  /** Decoded return value (`undefined` unless the call succeeded). */
  result: unknown;
  /** Resource usage (only for successful simulations). */
  resources: Resources | null;
}

/** Extra information passed to a property. */
export interface PropertyContext {
  /** Function being tested. */
  function: string;
  /** Classified outcome of the simulation. */
  outcome: Outcome;
  /** Resource usage (only for successful simulations). */
  resources: Resources | null;
  /**
   * Simulates another call on the same contract, e.g. `ctx.call('admin', {})`
   * or `ctx.call('balance', { id })`. Arguments are keyed by parameter name
   * (or given positionally as an array). Every call is a fresh simulation
   * (never cached), and state changes made by the function under test are
   * NOT visible to it: simulations do not change chain state.
   */
  call(fn: string, args?: Record<string, unknown> | unknown[]): Promise<CallResult>;
}

/**
 * What a property returns: `true` / `undefined` pass, `false` fails, a string
 * fails with that string as the message. Throwing also fails.
 */
export type PropertyVerdict = boolean | string | void | undefined;

/** A user-defined property. */
export interface Property {
  /** Short name shown in reports, e.g. "balance is never negative". */
  name: string;
  /** Function name(s) the property applies to, or `"*"` for every function. */
  function: string | string[];
  /**
   * The property.
   *
   * @param args - the call's arguments keyed by parameter name (native values, see docs/generators.md)
   * @param result - the decoded return value (`Result<T, E>` is unwrapped to `T`); `undefined` when the call failed
   * @param ctx - outcome and resource details
   */
  check: (
    args: Record<string, unknown>,
    result: unknown,
    ctx: PropertyContext,
  ) => PropertyVerdict | Promise<PropertyVerdict>;
  /**
   * Also evaluate the property when the call failed (contract error or trap).
   * Default `false`: properties only see successful calls.
   */
  includeFailures?: boolean;
}

/** Identity helper that gives type-checking in property files. */
export function defineProperties(properties: Property[]): Property[] {
  return properties;
}

/** True if the property applies to the given function. */
export function propertyApplies(p: Property, fn: string): boolean {
  const fns = Array.isArray(p.function) ? p.function : [p.function];
  return fns.includes('*') || fns.includes(fn);
}

/** Validates an untrusted value as a list of properties. */
export function validateProperties(value: unknown, source: string): Property[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((p, i) => {
    const where = `${source} (property #${i + 1})`;
    if (!p || typeof p !== 'object') throw new ConfigError(`${where}: must be an object`);
    const prop = p as Partial<Property>;
    if (typeof prop.name !== 'string' || prop.name === '')
      throw new ConfigError(`${where}: "name" must be a non-empty string`);
    const fns = Array.isArray(prop.function) ? prop.function : [prop.function];
    if (fns.length === 0 || !fns.every((f) => typeof f === 'string' && f !== '')) {
      throw new ConfigError(
        `${where}: "function" must be a function name, an array of names, or "*"`,
      );
    }
    if (typeof prop.check !== 'function')
      throw new ConfigError(`${where}: "check" must be a function`);
    return prop as Property;
  });
}

/** Loads properties from `.ts` / `.js` / `.mjs` files (default export: one property or an array). */
export async function loadProperties(files: readonly string[]): Promise<Property[]> {
  const out: Property[] = [];
  for (const file of files) {
    let mod: unknown;
    try {
      mod = await importModule(file);
    } catch (err) {
      throw new ConfigError(`cannot load properties from ${file}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    out.push(...validateProperties(mod, file));
  }
  return out;
}
