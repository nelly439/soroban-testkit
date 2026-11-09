/**
 * Typed conversion between native values (see `arbitraries.ts` for the
 * representation table) and XDR `ScVal`s.
 */
import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { SpecError } from '../errors.js';
import type { ContractSpec, TypeRef, UdtSpec } from '../spec/types.js';
import type { TaggedVal, UnionValue } from './arbitraries.js';

function fail(type: TypeRef, value: unknown): never {
  throw new SpecError(
    `cannot encode ${describe(value)} as ${type.kind === 'udt' ? type.name : type.kind}`,
  );
}

function describe(v: unknown): string {
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof Uint8Array) return 'Uint8Array';
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function lookup(spec: ContractSpec, name: string): UdtSpec {
  const udt = spec.types[name];
  if (!udt) throw new SpecError(`type "${name}" is referenced but not defined in the spec`);
  return udt;
}

const SCV_ORDER = [
  'scvBool',
  'scvVoid',
  'scvError',
  'scvU32',
  'scvI32',
  'scvU64',
  'scvI64',
  'scvTimepoint',
  'scvDuration',
  'scvU128',
  'scvI128',
  'scvU256',
  'scvI256',
  'scvBytes',
  'scvString',
  'scvSymbol',
  'scvVec',
  'scvMap',
  'scvAddress',
];

const NUMERIC = new Set([
  'scvU32',
  'scvI32',
  'scvU64',
  'scvI64',
  'scvTimepoint',
  'scvDuration',
  'scvU128',
  'scvI128',
  'scvU256',
  'scvI256',
]);

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/**
 * Total order on `ScVal`s matching the Soroban host's ordering for map keys:
 * first by value type, then numerically for integers, byte-wise for
 * bytes/strings/symbols, element-wise for vectors, and by XDR bytes otherwise.
 */
export function compareScVal(a: xdr.ScVal, b: xdr.ScVal): number {
  const ta = SCV_ORDER.indexOf(a.type);
  const tb = SCV_ORDER.indexOf(b.type);
  if (ta !== tb) return ta - tb;
  if (NUMERIC.has(a.type)) {
    const x = BigInt(scValToNative(a) as bigint | number);
    const y = BigInt(scValToNative(b) as bigint | number);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (a.type === 'scvBool') return Number(scValToNative(a)) - Number(scValToNative(b));
  if (a.type === 'scvBytes' || a.type === 'scvString' || a.type === 'scvSymbol') {
    return compareBytes(rawBytes(a), rawBytes(b));
  }
  if (a.type === 'scvVec') {
    const va = (a as xdr.ScValVec).vec ?? [];
    const vb = (b as xdr.ScValVec).vec ?? [];
    for (let i = 0; i < Math.min(va.length, vb.length); i++) {
      const c = compareScVal(va[i]!, vb[i]!);
      if (c !== 0) return c;
    }
    return va.length - vb.length;
  }
  return compareBytes(a.toXdr(), b.toXdr());
}

function rawBytes(v: xdr.ScVal): Uint8Array {
  const n = scValToNative(v) as unknown;
  if (n instanceof Uint8Array) return n;
  return new TextEncoder().encode(String(n));
}

/** Builds an `ScMap` with entries sorted by key, as the host requires. */
export function sortedMap(entries: Array<[xdr.ScVal, xdr.ScVal]>): xdr.ScVal {
  const sorted = [...entries].sort((x, y) => compareScVal(x[0], y[0]));
  return xdr.ScVal.scvMap(sorted.map(([key, val]) => new xdr.ScMapEntry({ key, val })));
}

function intScVal(kind: string, value: unknown, type: TypeRef): xdr.ScVal {
  if (typeof value !== 'bigint' && typeof value !== 'number') fail(type, value);
  if (kind === 'timepoint' || kind === 'duration') {
    return xdr.ScVal.fromJson({ [kind]: String(value) } as xdr.JsonValue);
  }
  return nativeToScVal(BigInt(value), { type: kind } as Parameters<typeof nativeToScVal>[1]);
}

function isTupleStruct(udt: UdtSpec): boolean {
  return (
    udt.kind === 'struct' && udt.fields.length > 0 && udt.fields.every((f) => /^\d+$/.test(f.name))
  );
}

/** Encodes a native value as an `ScVal` of the given spec type. */
export function toScVal(type: TypeRef, value: unknown, spec: ContractSpec): xdr.ScVal {
  switch (type.kind) {
    case 'bool':
      if (typeof value !== 'boolean') fail(type, value);
      return xdr.ScVal.scvBool(value);
    case 'void':
      return xdr.ScVal.scvVoid();
    case 'u32':
      if (typeof value !== 'number') fail(type, value);
      return xdr.ScVal.scvU32(value);
    case 'i32':
      if (typeof value !== 'number') fail(type, value);
      return xdr.ScVal.scvI32(value);
    case 'u64':
    case 'i64':
    case 'timepoint':
    case 'duration':
    case 'u128':
    case 'i128':
    case 'u256':
    case 'i256':
      return intScVal(type.kind, value, type);
    case 'symbol':
      if (typeof value !== 'string') fail(type, value);
      return xdr.ScVal.scvSymbol(value);
    case 'string':
      if (typeof value !== 'string') fail(type, value);
      return xdr.ScVal.scvString(new TextEncoder().encode(value));
    case 'bytes':
    case 'bytesN':
      if (!(value instanceof Uint8Array)) fail(type, value);
      return xdr.ScVal.scvBytes(value);
    case 'address':
    case 'muxed_address':
      if (typeof value !== 'string') fail(type, value);
      return Address.fromString(value).toScVal();
    case 'error':
      if (typeof value !== 'number') fail(type, value);
      return xdr.ScVal.scvError(xdr.ScError.sceContract(value));
    case 'val': {
      const t = value as TaggedVal;
      if (!t || typeof t !== 'object' || !('$type' in t)) fail(type, value);
      return toScVal({ kind: t.$type }, t.value, spec);
    }
    case 'option':
      return value === null || value === undefined
        ? xdr.ScVal.scvVoid()
        : toScVal(type.value, value, spec);
    case 'result': {
      const r = value as { ok?: unknown; err?: unknown };
      if (r && typeof r === 'object' && 'ok' in r) return toScVal(type.ok, r.ok, spec);
      if (r && typeof r === 'object' && 'err' in r) return toScVal(type.error, r.err, spec);
      return fail(type, value);
    }
    case 'vec':
      if (!Array.isArray(value)) fail(type, value);
      return xdr.ScVal.scvVec(value.map((v) => toScVal(type.element, v, spec)));
    case 'map':
      if (!Array.isArray(value)) fail(type, value);
      return sortedMap(
        value.map((entry) => {
          if (!Array.isArray(entry) || entry.length !== 2) fail(type, value);
          return [toScVal(type.key, entry[0], spec), toScVal(type.value, entry[1], spec)];
        }),
      );
    case 'tuple':
      if (!Array.isArray(value) || value.length !== type.elements.length) fail(type, value);
      return xdr.ScVal.scvVec(type.elements.map((t, i) => toScVal(t, value[i], spec)));
    case 'udt':
      return udtToScVal(lookup(spec, type.name), value, spec, type);
  }
}

function udtToScVal(udt: UdtSpec, value: unknown, spec: ContractSpec, type: TypeRef): xdr.ScVal {
  switch (udt.kind) {
    case 'struct': {
      if (!value || typeof value !== 'object') fail(type, value);
      const obj = value as Record<string, unknown>;
      if (isTupleStruct(udt)) {
        return xdr.ScVal.scvVec(udt.fields.map((f) => toScVal(f.type, obj[f.name], spec)));
      }
      return sortedMap(
        udt.fields.map((f) => [xdr.ScVal.scvSymbol(f.name), toScVal(f.type, obj[f.name], spec)]),
      );
    }
    case 'enum':
      if (typeof value !== 'number') fail(type, value);
      return xdr.ScVal.scvU32(value);
    case 'errorEnum':
      if (typeof value !== 'number') fail(type, value);
      return xdr.ScVal.scvError(xdr.ScError.sceContract(value));
    case 'union': {
      const u = value as UnionValue;
      const c = udt.cases.find((x) => x.name === u?.tag);
      if (!c) fail(type, value);
      const head = xdr.ScVal.scvSymbol(c.name);
      if (c.kind === 'void') return xdr.ScVal.scvVec([head]);
      return xdr.ScVal.scvVec([head, ...c.types.map((t, i) => toScVal(t, u.values[i], spec))]);
    }
  }
}

/** Encodes a full argument list for a function. */
export function argsToScVals(
  types: readonly TypeRef[],
  args: readonly unknown[],
  spec: ContractSpec,
): xdr.ScVal[] {
  return types.map((t, i) => toScVal(t, args[i], spec));
}

/**
 * Decodes an `ScVal` into the native representation of the given type.
 * Values that do not match the declared type fall back to the SDK's generic
 * `scValToNative`. A `Result<T, E>` return type decodes as `T`, because an
 * `Err` never reaches the caller as a value (it fails the invocation).
 */
export function fromScVal(type: TypeRef, val: xdr.ScVal, spec: ContractSpec): unknown {
  try {
    return decodeStrict(type, val, spec);
  } catch {
    return scValToNative(val) as unknown;
  }
}

function expectType(val: xdr.ScVal, ...types: string[]): void {
  if (!types.includes(val.type)) throw new Error(`expected ${types.join('|')}, got ${val.type}`);
}

function decodeStrict(type: TypeRef, val: xdr.ScVal, spec: ContractSpec): unknown {
  switch (type.kind) {
    case 'bool':
      expectType(val, 'scvBool');
      return scValToNative(val) as boolean;
    case 'void':
      expectType(val, 'scvVoid');
      return null;
    case 'u32':
    case 'i32':
      expectType(val, type.kind === 'u32' ? 'scvU32' : 'scvI32');
      return Number(scValToNative(val));
    case 'u64':
    case 'i64':
    case 'timepoint':
    case 'duration':
    case 'u128':
    case 'i128':
    case 'u256':
    case 'i256':
      expectType(val, 'scv' + type.kind[0]!.toUpperCase() + type.kind.slice(1));
      return BigInt(scValToNative(val) as bigint);
    case 'symbol':
      expectType(val, 'scvSymbol');
      return String(scValToNative(val));
    case 'string':
      expectType(val, 'scvString');
      return new TextDecoder().decode((val as xdr.ScValString).str.bytes);
    case 'bytes':
    case 'bytesN':
      expectType(val, 'scvBytes');
      return new Uint8Array(scValToNative(val) as Uint8Array);
    case 'address':
    case 'muxed_address':
      expectType(val, 'scvAddress');
      return Address.fromScVal(val).toString();
    case 'error':
      expectType(val, 'scvError');
      return contractErrorCode(val);
    case 'val':
      return scValToNative(val) as unknown;
    case 'option':
      return val.type === 'scvVoid' ? null : decodeStrict(type.value, val, spec);
    case 'result':
      return decodeStrict(type.ok, val, spec);
    case 'vec': {
      expectType(val, 'scvVec');
      return ((val as xdr.ScValVec).vec ?? []).map((v) => decodeStrict(type.element, v, spec));
    }
    case 'map': {
      expectType(val, 'scvMap');
      return ((val as xdr.ScValMap).map ?? []).map((e) => [
        decodeStrict(type.key, e.key, spec),
        decodeStrict(type.value, e.val, spec),
      ]);
    }
    case 'tuple': {
      expectType(val, 'scvVec');
      const items = (val as xdr.ScValVec).vec ?? [];
      return type.elements.map((t, i) => decodeStrict(t, items[i]!, spec));
    }
    case 'udt':
      return decodeUdt(lookup(spec, type.name), val, spec);
  }
}

function decodeUdt(udt: UdtSpec, val: xdr.ScVal, spec: ContractSpec): unknown {
  switch (udt.kind) {
    case 'struct': {
      if (isTupleStruct(udt)) {
        expectType(val, 'scvVec');
        const items = (val as xdr.ScValVec).vec ?? [];
        return Object.fromEntries(
          udt.fields.map((f, i) => [f.name, decodeStrict(f.type, items[i]!, spec)]),
        );
      }
      expectType(val, 'scvMap');
      const entries = (val as xdr.ScValMap).map ?? [];
      const out: Record<string, unknown> = {};
      for (const f of udt.fields) {
        const e = entries.find(
          (x) => x.key.type === 'scvSymbol' && scValToNative(x.key) === f.name,
        );
        if (!e) throw new Error(`missing field ${f.name}`);
        out[f.name] = decodeStrict(f.type, e.val, spec);
      }
      return out;
    }
    case 'enum':
      expectType(val, 'scvU32');
      return Number(scValToNative(val));
    case 'errorEnum':
      expectType(val, 'scvError');
      return contractErrorCode(val);
    case 'union': {
      expectType(val, 'scvVec');
      const [head, ...rest] = (val as xdr.ScValVec).vec ?? [];
      if (!head) throw new Error('empty union vec');
      const tag = String(scValToNative(head));
      const c = udt.cases.find((x) => x.name === tag);
      if (!c) throw new Error(`unknown case ${tag}`);
      return {
        tag,
        values: c.kind === 'void' ? [] : c.types.map((t, i) => decodeStrict(t, rest[i]!, spec)),
      } satisfies UnionValue;
    }
  }
}

function contractErrorCode(val: xdr.ScVal): number {
  const json = val.toJson() as { error?: { contract?: number } };
  if (typeof json.error?.contract === 'number') return json.error.contract;
  throw new Error('not a contract error');
}
