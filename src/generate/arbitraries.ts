/**
 * Maps Soroban spec types to fast-check arbitraries and to ordered lists of
 * boundary values.
 *
 * ## Native value representation
 *
 * | spec type                         | JS value                                   |
 * | --------------------------------- | ------------------------------------------ |
 * | bool                              | `boolean`                                  |
 * | u32, i32                          | `number`                                   |
 * | u64, i64, u128, i128, u256, i256, timepoint, duration | `bigint`               |
 * | symbol, string                    | `string`                                   |
 * | bytes, BytesN<n>                  | `Uint8Array`                               |
 * | address, muxed_address            | `string` (`G...` or `C...` strkey)         |
 * | Vec<T>, tuple                     | `Array`                                    |
 * | Map<K, V>                         | `Array<[K, V]>` (unique keys)              |
 * | Option<T>                         | `T` or `null`                              |
 * | Result<T, E>                      | `{ ok: T }` or `{ err: E }`                |
 * | struct                            | plain object keyed by field name           |
 * | union                             | `{ tag: string, values: unknown[] }`       |
 * | enum, error enum, Error           | `number` (discriminant / error code)       |
 * | void                              | `null`                                     |
 * | Val                               | `{ $type: PrimitiveKind, value }`          |
 */
import fc from 'fast-check';
import { StrKey } from '@stellar/stellar-sdk';
import { SpecError } from '../errors.js';
import type { ContractSpec, FunctionSpec, PrimitiveKind, TypeRef, UdtSpec } from '../spec/types.js';

/** Tunables for value generation. */
export interface GeneratorOptions {
  /** Maximum length of generated `Vec`s and `Map`s. Default 5. */
  maxCollectionLength: number;
  /** Maximum length (in characters) of generated `String`s. Default 32. */
  maxStringLength: number;
  /** Maximum length of generated `Bytes`. Default 64. */
  maxBytesLength: number;
  /** Extra addresses (G... / C...) used as boundary values and mixed into random addresses. */
  addresses: string[];
  /** Maximum nesting depth of user-defined types before generation is forced to the smallest case. Default 4. */
  maxDepth: number;
  /** Maximum number of boundary cases per function. Default 200. */
  maxBoundaryCases: number;
}

/** Default {@link GeneratorOptions}. */
export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  maxCollectionLength: 5,
  maxStringLength: 32,
  maxBytesLength: 64,
  addresses: [],
  maxDepth: 4,
  maxBoundaryCases: 200,
};

/** Value of a `Val`-typed parameter: a primitive tagged with its concrete type. */
export interface TaggedVal {
  $type: PrimitiveKind;
  value: unknown;
}

/** Value of a union: the case name plus its tuple payload. */
export interface UnionValue {
  tag: string;
  values: unknown[];
}

interface IntRange {
  min: bigint;
  max: bigint;
}

/** Inclusive ranges of every integer spec type. */
export const INT_RANGES: Record<string, IntRange> = {
  u32: { min: 0n, max: 2n ** 32n - 1n },
  i32: { min: -(2n ** 31n), max: 2n ** 31n - 1n },
  u64: { min: 0n, max: 2n ** 64n - 1n },
  i64: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
  timepoint: { min: 0n, max: 2n ** 64n - 1n },
  duration: { min: 0n, max: 2n ** 64n - 1n },
  u128: { min: 0n, max: 2n ** 128n - 1n },
  i128: { min: -(2n ** 127n), max: 2n ** 127n - 1n },
  u256: { min: 0n, max: 2n ** 256n - 1n },
  i256: { min: -(2n ** 255n), max: 2n ** 255n - 1n },
};

const SYMBOL_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('');
/** Maximum length of a Soroban `Symbol`. */
export const MAX_SYMBOL_LENGTH = 32;

const isSmallInt = (k: string): boolean => k === 'u32' || k === 'i32';

function lookupUdt(spec: ContractSpec, name: string): UdtSpec {
  const udt = spec.types[name];
  if (!udt) throw new SpecError(`type "${name}" is referenced but not defined in the spec`);
  return udt;
}

function accountArb(): fc.Arbitrary<string> {
  return fc.uint8Array({ minLength: 32, maxLength: 32 }).map(
    (b) => StrKey.encodeEd25519PublicKey(Buffer.from(b)),
    (s) => {
      if (typeof s !== 'string' || !StrKey.isValidEd25519PublicKey(s)) throw new Error('not G');
      return new Uint8Array(StrKey.decodeEd25519PublicKey(s));
    },
  );
}

function contractArb(): fc.Arbitrary<string> {
  return fc.uint8Array({ minLength: 32, maxLength: 32 }).map(
    (b) => StrKey.encodeContract(Buffer.from(b)),
    (s) => {
      if (typeof s !== 'string' || !StrKey.isValidContract(s)) throw new Error('not C');
      return new Uint8Array(StrKey.decodeContract(s));
    },
  );
}

/** Fixed addresses used as boundary values: all-zero and all-0xff keys of both kinds. */
export const BOUNDARY_ADDRESSES: readonly string[] = [
  StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0)),
  StrKey.encodeContract(Buffer.alloc(32, 0)),
  StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0xff)),
  StrKey.encodeContract(Buffer.alloc(32, 0xff)),
];

/** Canonical string key for a native value, used for map-key uniqueness and dedupe. */
export function valueKey(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (typeof x === 'bigint') return `${x}n`;
    if (x instanceof Uint8Array) return `0x${Buffer.from(x).toString('hex')}`;
    return x;
  });
}

function dedupe<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = valueKey(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Builds a fast-check arbitrary producing native values of the given type.
 * All arbitraries support shrinking of user-supplied examples (unmappers are
 * provided for every mapped arbitrary).
 */
export function arbitraryFor(
  type: TypeRef,
  spec: ContractSpec,
  options: GeneratorOptions = DEFAULT_GENERATOR_OPTIONS,
  depth = 0,
): fc.Arbitrary<unknown> {
  const deep = depth >= options.maxDepth;
  const rec = (t: TypeRef): fc.Arbitrary<unknown> => arbitraryFor(t, spec, options, depth + 1);
  switch (type.kind) {
    case 'bool':
      return fc.boolean();
    case 'void':
      return fc.constant(null);
    case 'u32':
    case 'i32': {
      const r = INT_RANGES[type.kind]!;
      return fc.integer({ min: Number(r.min), max: Number(r.max) });
    }
    case 'u64':
    case 'i64':
    case 'timepoint':
    case 'duration':
    case 'u128':
    case 'i128':
    case 'u256':
    case 'i256': {
      const r = INT_RANGES[type.kind]!;
      return fc.bigInt({ min: r.min, max: r.max });
    }
    case 'symbol':
      return fc.string({ unit: fc.constantFrom(...SYMBOL_CHARS), maxLength: MAX_SYMBOL_LENGTH });
    case 'string':
      return fc.string({ unit: 'binary', maxLength: options.maxStringLength });
    case 'bytes':
      return fc.uint8Array({ maxLength: options.maxBytesLength });
    case 'bytesN':
      return fc.uint8Array({ minLength: type.n, maxLength: type.n });
    case 'address':
    case 'muxed_address': {
      const arbs: fc.Arbitrary<string>[] = [accountArb(), contractArb()];
      if (options.addresses.length > 0) arbs.push(fc.constantFrom(...options.addresses));
      return fc.oneof(...arbs);
    }
    case 'error':
      return fc.integer({ min: 0, max: 1000 });
    case 'val':
      return fc.oneof(
        fc.boolean().map(
          (value): TaggedVal => ({ $type: 'bool', value }),
          (t) => unTag<boolean>(t, 'bool'),
        ),
        fc.integer({ min: 0, max: 2 ** 32 - 1 }).map(
          (value): TaggedVal => ({ $type: 'u32', value }),
          (t) => unTag<number>(t, 'u32'),
        ),
        fc.bigInt({ min: INT_RANGES.i128!.min, max: INT_RANGES.i128!.max }).map(
          (value): TaggedVal => ({ $type: 'i128', value }),
          (t) => unTag<bigint>(t, 'i128'),
        ),
        fc.string({ unit: fc.constantFrom(...SYMBOL_CHARS), maxLength: 10 }).map(
          (value): TaggedVal => ({ $type: 'symbol', value }),
          (t) => unTag<string>(t, 'symbol'),
        ),
      );
    case 'option':
      return deep ? fc.constant(null) : fc.option(rec(type.value), { nil: null });
    case 'result':
      return fc.oneof(
        rec(type.ok).map(
          (ok) => ({ ok }),
          (r) => unwrapKey(r, 'ok'),
        ),
        rec(type.error).map(
          (err) => ({ err }),
          (r) => unwrapKey(r, 'err'),
        ),
      );
    case 'vec':
      return deep
        ? fc.constant([])
        : fc.array(rec(type.element), { maxLength: options.maxCollectionLength });
    case 'map':
      return deep
        ? fc.constant([])
        : fc.uniqueArray(fc.tuple(rec(type.key), rec(type.value)), {
            maxLength: options.maxCollectionLength,
            selector: (entry) => valueKey(entry[0]),
          });
    case 'tuple':
      return fc.tuple(...type.elements.map(rec));
    case 'udt':
      return udtArbitrary(lookupUdt(spec, type.name), spec, options, depth);
  }
}

function unTag<T>(t: unknown, kind: PrimitiveKind): T {
  if (t && typeof t === 'object' && (t as TaggedVal).$type === kind)
    return (t as TaggedVal).value as T;
  throw new Error('tag mismatch');
}

function unwrapKey(r: unknown, key: string): unknown {
  if (r && typeof r === 'object' && key in r && Object.keys(r).length === 1) {
    return (r as Record<string, unknown>)[key];
  }
  throw new Error('shape mismatch');
}

function udtArbitrary(
  udt: UdtSpec,
  spec: ContractSpec,
  options: GeneratorOptions,
  depth: number,
): fc.Arbitrary<unknown> {
  const rec = (t: TypeRef): fc.Arbitrary<unknown> => arbitraryFor(t, spec, options, depth + 1);
  switch (udt.kind) {
    case 'struct': {
      const model: Record<string, fc.Arbitrary<unknown>> = {};
      for (const f of udt.fields) model[f.name] = rec(f.type);
      return fc.record(model);
    }
    case 'enum':
    case 'errorEnum':
      if (udt.cases.length === 0) throw new SpecError(`${udt.name} has no cases`);
      return fc.constantFrom(...udt.cases.map((c) => c.value));
    case 'union': {
      const deep = depth >= options.maxDepth;
      const voidCases = udt.cases.filter((c) => c.kind === 'void');
      const cases = deep && voidCases.length > 0 ? voidCases : udt.cases;
      if (cases.length === 0) throw new SpecError(`${udt.name} has no cases`);
      return fc.oneof(
        ...cases.map((c) =>
          c.kind === 'void'
            ? fc.constant<UnionValue>({ tag: c.name, values: [] })
            : fc.tuple(...c.types.map(rec)).map(
                (values): UnionValue => ({ tag: c.name, values }),
                (u) => {
                  const uv = u as UnionValue;
                  if (!uv || uv.tag !== c.name || !Array.isArray(uv.values)) {
                    throw new Error('case mismatch');
                  }
                  return uv.values;
                },
              ),
        ),
      );
    }
  }
}

function intBoundaries(kind: string): unknown[] {
  const r = INT_RANGES[kind]!;
  const raw = [0n, 1n, r.max, r.max - 1n];
  if (r.min < 0n) raw.push(r.min, r.min + 1n, -1n);
  return dedupe(raw).map((v) => (isSmallInt(kind) ? Number(v) : v));
}

/**
 * Ordered boundary values for a type: the "interesting" edges (zero, one,
 * min, max, max-1, empty and single-element collections, ...). The first
 * element is the type's simplest value. Lists are capped at `cap` entries.
 */
export function boundaryValues(
  type: TypeRef,
  spec: ContractSpec,
  options: GeneratorOptions = DEFAULT_GENERATOR_OPTIONS,
  depth = 0,
  cap = 12,
): unknown[] {
  const deep = depth >= options.maxDepth;
  const rec = (t: TypeRef): unknown[] => boundaryValues(t, spec, options, depth + 1, cap);
  let out: unknown[];
  switch (type.kind) {
    case 'bool':
      out = [false, true];
      break;
    case 'void':
      out = [null];
      break;
    case 'u32':
    case 'i32':
    case 'u64':
    case 'i64':
    case 'timepoint':
    case 'duration':
    case 'u128':
    case 'i128':
    case 'u256':
    case 'i256':
      out = intBoundaries(type.kind);
      break;
    case 'symbol':
      out = ['', 'a', '_', 'a'.repeat(MAX_SYMBOL_LENGTH)];
      break;
    case 'string':
      out = ['', 'a', 'x'.repeat(options.maxStringLength), 'é', '\u0000'];
      break;
    case 'bytes':
      out = [
        new Uint8Array(0),
        new Uint8Array([0]),
        new Uint8Array([0xff]),
        new Uint8Array(options.maxBytesLength),
      ];
      break;
    case 'bytesN':
      out = [new Uint8Array(type.n), new Uint8Array(type.n).fill(0xff)];
      break;
    case 'address':
    case 'muxed_address':
      out = [...BOUNDARY_ADDRESSES, ...options.addresses];
      break;
    case 'error':
      out = [0, 1];
      break;
    case 'val':
      out = [
        { $type: 'bool', value: false },
        { $type: 'u32', value: 0 },
        { $type: 'i128', value: 0n },
        { $type: 'symbol', value: '' },
      ];
      break;
    case 'option':
      out = deep ? [null] : [null, ...rec(type.value)];
      break;
    case 'result':
      out = [
        ...rec(type.ok).map((ok) => ({ ok })),
        ...rec(type.error)
          .slice(0, 2)
          .map((err) => ({ err })),
      ];
      break;
    case 'vec':
      out = deep
        ? [[]]
        : [
            [],
            ...rec(type.element)
              .slice(0, 3)
              .map((e) => [e]),
          ];
      break;
    case 'map': {
      if (deep) {
        out = [[]];
        break;
      }
      const vals = rec(type.value);
      out = [
        [],
        ...rec(type.key)
          .slice(0, 2)
          .map((k) => [[k, vals[0]]]),
      ];
      break;
    }
    case 'tuple':
      out = combineBoundaries(type.elements.map(rec), cap).map((vals) => vals);
      break;
    case 'udt':
      out = udtBoundaries(lookupUdt(spec, type.name), spec, options, depth, cap);
      break;
  }
  return dedupe(out).slice(0, cap);
}

function udtBoundaries(
  udt: UdtSpec,
  spec: ContractSpec,
  options: GeneratorOptions,
  depth: number,
  cap: number,
): unknown[] {
  const rec = (t: TypeRef): unknown[] => boundaryValues(t, spec, options, depth + 1, cap);
  switch (udt.kind) {
    case 'struct':
      return combineBoundaries(
        udt.fields.map((f) => rec(f.type)),
        cap,
      ).map((vals) => Object.fromEntries(udt.fields.map((f, i) => [f.name, vals[i]])));
    case 'enum':
    case 'errorEnum':
      return udt.cases.map((c) => c.value);
    case 'union': {
      const deep = depth >= options.maxDepth;
      const voidCases = udt.cases.filter((c) => c.kind === 'void');
      const cases = deep && voidCases.length > 0 ? voidCases : udt.cases;
      const out: UnionValue[] = [];
      for (const c of cases) {
        if (c.kind === 'void') out.push({ tag: c.name, values: [] });
        else out.push({ tag: c.name, values: c.types.map((t) => rec(t)[0]) });
      }
      for (const c of cases) {
        if (c.kind === 'tuple') {
          for (const values of combineBoundaries(c.types.map(rec), cap).slice(1)) {
            out.push({ tag: c.name, values });
          }
        }
      }
      return out;
    }
  }
}

/**
 * Combines per-position boundary lists into tuples, in this order:
 *
 * 1. every position at its first (simplest) boundary;
 * 2. one position at a time varied over its other boundaries;
 * 3. the "diagonal": every position at its k-th boundary (e.g. all max).
 *
 * Duplicates are removed and the result is capped at `cap` tuples.
 */
export function combineBoundaries(lists: readonly unknown[][], cap: number): unknown[][] {
  if (lists.length === 0) return [[]];
  const base = lists.map((l) => l[0]);
  const out: unknown[][] = [base];
  lists.forEach((list, i) => {
    for (const v of list.slice(1)) {
      const t = [...base];
      t[i] = v;
      out.push(t);
    }
  });
  const longest = Math.max(...lists.map((l) => l.length));
  for (let k = 1; k < longest; k++) {
    out.push(lists.map((l) => l[Math.min(k, l.length - 1)]));
  }
  return dedupe(out).slice(0, cap);
}

/** Arbitrary producing a full argument list for a function. */
export function argumentsArbitrary(
  fn: FunctionSpec,
  spec: ContractSpec,
  options: GeneratorOptions = DEFAULT_GENERATOR_OPTIONS,
): fc.Arbitrary<unknown[]> {
  return fc.tuple(...fn.inputs.map((i) => arbitraryFor(i.type, spec, options)));
}

/** Boundary argument lists for a function, in the order they are run. */
export function boundaryCases(
  fn: FunctionSpec,
  spec: ContractSpec,
  options: GeneratorOptions = DEFAULT_GENERATOR_OPTIONS,
): unknown[][] {
  const lists = fn.inputs.map((i) => boundaryValues(i.type, spec, options));
  return combineBoundaries(lists, options.maxBoundaryCases);
}
