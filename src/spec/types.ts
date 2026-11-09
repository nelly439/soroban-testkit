/**
 * Plain, JSON-friendly model of a Soroban contract interface.
 *
 * The XDR `ScSpecEntry` types from `@stellar/stellar-sdk` are converted into
 * these shapes once, so the rest of the tool never has to touch XDR spec
 * objects directly.
 *
 * @packageDocumentation
 */

/** Spec types that carry no parameters. */
export type PrimitiveKind =
  | 'val'
  | 'bool'
  | 'void'
  | 'error'
  | 'u32'
  | 'i32'
  | 'u64'
  | 'i64'
  | 'timepoint'
  | 'duration'
  | 'u128'
  | 'i128'
  | 'u256'
  | 'i256'
  | 'bytes'
  | 'string'
  | 'symbol'
  | 'address'
  | 'muxed_address';

/** All primitive kinds, in spec order. */
export const PRIMITIVE_KINDS: readonly PrimitiveKind[] = [
  'val',
  'bool',
  'void',
  'error',
  'u32',
  'i32',
  'u64',
  'i64',
  'timepoint',
  'duration',
  'u128',
  'i128',
  'u256',
  'i256',
  'bytes',
  'string',
  'symbol',
  'address',
  'muxed_address',
];

/** A reference to a Soroban spec type. */
export type TypeRef =
  | { kind: PrimitiveKind }
  | { kind: 'option'; value: TypeRef }
  | { kind: 'result'; ok: TypeRef; error: TypeRef }
  | { kind: 'vec'; element: TypeRef }
  | { kind: 'map'; key: TypeRef; value: TypeRef }
  | { kind: 'tuple'; elements: TypeRef[] }
  | { kind: 'bytesN'; n: number }
  | { kind: 'udt'; name: string };

/** A named, typed function parameter or struct field. */
export interface NamedType {
  /** Parameter or field name. */
  name: string;
  /** Declared type. */
  type: TypeRef;
  /** Doc comment from the contract source, if any. */
  doc: string;
}

/** A contract function. */
export interface FunctionSpec {
  /** Function name as invoked on chain. */
  name: string;
  /** Doc comment. */
  doc: string;
  /** Parameters, in call order. */
  inputs: NamedType[];
  /** Return types (Soroban functions have zero or one). */
  outputs: TypeRef[];
}

/** A user-defined struct (`#[contracttype] struct`). */
export interface StructSpec {
  kind: 'struct';
  name: string;
  doc: string;
  /** Library the type was imported from, if any. */
  lib: string;
  fields: NamedType[];
}

/** One case of a user-defined union (`#[contracttype] enum` with data). */
export type UnionCase =
  | { kind: 'void'; name: string; doc: string }
  | { kind: 'tuple'; name: string; doc: string; types: TypeRef[] };

/** A user-defined union. */
export interface UnionSpec {
  kind: 'union';
  name: string;
  doc: string;
  lib: string;
  cases: UnionCase[];
}

/** A case of an integer enum or error enum. */
export interface EnumCase {
  name: string;
  value: number;
  doc: string;
}

/** A user-defined integer enum (`#[contracttype] enum` with `= N` discriminants). */
export interface EnumSpec {
  kind: 'enum';
  name: string;
  doc: string;
  lib: string;
  cases: EnumCase[];
}

/** A contract error enum (`#[contracterror]`). */
export interface ErrorEnumSpec {
  kind: 'errorEnum';
  name: string;
  doc: string;
  lib: string;
  cases: EnumCase[];
}

/** Any user-defined type. */
export type UdtSpec = StructSpec | UnionSpec | EnumSpec | ErrorEnumSpec;

/** The full, parsed interface of a contract. */
export interface ContractSpec {
  /** Contract functions, in the order they appear in the spec. */
  functions: FunctionSpec[];
  /** User-defined types keyed by name. */
  types: Record<string, UdtSpec>;
  /** Names of events declared in the spec (events are not fuzzed). */
  events: string[];
}

/** Returns the declared error codes of a contract (all error enums merged). */
export function declaredErrorCodes(spec: ContractSpec): Map<number, string> {
  const codes = new Map<number, string>();
  for (const t of Object.values(spec.types)) {
    if (t.kind === 'errorEnum') {
      for (const c of t.cases) codes.set(c.value, `${t.name}::${c.name}`);
    }
  }
  return codes;
}

/** Renders a type reference in Rust-like notation, e.g. `Vec<Option<u32>>`. */
export function formatType(t: TypeRef): string {
  switch (t.kind) {
    case 'option':
      return `Option<${formatType(t.value)}>`;
    case 'result':
      return `Result<${formatType(t.ok)}, ${formatType(t.error)}>`;
    case 'vec':
      return `Vec<${formatType(t.element)}>`;
    case 'map':
      return `Map<${formatType(t.key)}, ${formatType(t.value)}>`;
    case 'tuple':
      return `(${t.elements.map(formatType).join(', ')})`;
    case 'bytesN':
      return `BytesN<${t.n}>`;
    case 'udt':
      return t.name;
    case 'void':
      return '()';
    case 'val':
      return 'Val';
    case 'bool':
      return 'bool';
    case 'error':
      return 'Error';
    case 'bytes':
      return 'Bytes';
    case 'string':
      return 'String';
    case 'symbol':
      return 'Symbol';
    case 'address':
      return 'Address';
    case 'muxed_address':
      return 'MuxedAddress';
    case 'timepoint':
      return 'Timepoint';
    case 'duration':
      return 'Duration';
    default:
      return t.kind;
  }
}
