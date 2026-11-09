/**
 * Conversion between the XDR-JSON representation of spec entries (the format
 * produced by `ScSpecEntry#toJson()` and by `stellar contract info interface
 * --output json`) and the plain {@link ContractSpec} model.
 */
import { xdr } from '@stellar/stellar-sdk';
import { SpecError } from '../errors.js';
import type {
  ContractSpec,
  EnumCase,
  FunctionSpec,
  NamedType,
  PrimitiveKind,
  TypeRef,
  UdtSpec,
  UnionCase,
} from './types.js';
import { PRIMITIVE_KINDS } from './types.js';

type Json = unknown;

/**
 * Escapes a JS string the way stellar-xdr JSON escapes `string<N>` fields
 * (UTF-8 bytes; printable ASCII verbatim, everything else as `\xNN`).
 */
export function escapeXdrString(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (const b of bytes) {
    if (b === 0x5c) out += '\\\\';
    else if (b === 0) out += '\\0';
    else if (b === 0x09) out += '\\t';
    else if (b === 0x0a) out += '\\n';
    else if (b === 0x0d) out += '\\r';
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += '\\x' + b.toString(16).padStart(2, '0');
  }
  return out;
}

/** Reverses {@link escapeXdrString}. Invalid UTF-8 is replaced with U+FFFD. */
export function unescapeXdrString(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch !== '\\') {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = s[i + 1];
    i++;
    switch (next) {
      case '\\':
        bytes.push(0x5c);
        break;
      case '0':
        bytes.push(0);
        break;
      case 't':
        bytes.push(0x09);
        break;
      case 'n':
        bytes.push(0x0a);
        break;
      case 'r':
        bytes.push(0x0d);
        break;
      case 'x':
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
        break;
      default:
        // Unknown escape: keep it verbatim.
        bytes.push(0x5c, ...new TextEncoder().encode(next ?? ''));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function isObj(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: Json, what: string): string {
  if (typeof v !== 'string') throw new SpecError(`expected string for ${what}`);
  return unescapeXdrString(v);
}

/** Converts an XDR-JSON `SCSpecTypeDef` into a {@link TypeRef}. */
export function typeFromJson(v: Json): TypeRef {
  if (typeof v === 'string') {
    if ((PRIMITIVE_KINDS as readonly string[]).includes(v)) return { kind: v as PrimitiveKind };
    throw new SpecError(`unknown spec type "${v}"`);
  }
  if (!isObj(v)) throw new SpecError(`invalid spec type ${JSON.stringify(v)}`);
  const [key, body] = Object.entries(v)[0] ?? [];
  if (!isObj(body)) throw new SpecError(`invalid spec type ${JSON.stringify(v)}`);
  switch (key) {
    case 'option':
      return { kind: 'option', value: typeFromJson(body.value_type) };
    case 'result':
      return {
        kind: 'result',
        ok: typeFromJson(body.ok_type),
        error: typeFromJson(body.error_type),
      };
    case 'vec':
      return { kind: 'vec', element: typeFromJson(body.element_type) };
    case 'map':
      return {
        kind: 'map',
        key: typeFromJson(body.key_type),
        value: typeFromJson(body.value_type),
      };
    case 'tuple':
      if (!Array.isArray(body.value_types)) throw new SpecError('tuple without value_types');
      return { kind: 'tuple', elements: body.value_types.map(typeFromJson) };
    case 'bytes_n':
      return { kind: 'bytesN', n: Number(body.n) };
    case 'udt':
      return { kind: 'udt', name: str(body.name, 'udt name') };
    default:
      throw new SpecError(`unknown spec type "${String(key)}"`);
  }
}

/** Converts a {@link TypeRef} into XDR-JSON. */
export function typeToJson(t: TypeRef): Json {
  switch (t.kind) {
    case 'option':
      return { option: { value_type: typeToJson(t.value) } };
    case 'result':
      return { result: { ok_type: typeToJson(t.ok), error_type: typeToJson(t.error) } };
    case 'vec':
      return { vec: { element_type: typeToJson(t.element) } };
    case 'map':
      return { map: { key_type: typeToJson(t.key), value_type: typeToJson(t.value) } };
    case 'tuple':
      return { tuple: { value_types: t.elements.map(typeToJson) } };
    case 'bytesN':
      return { bytes_n: { n: t.n } };
    case 'udt':
      return { udt: { name: escapeXdrString(t.name) } };
    default:
      return t.kind;
  }
}

function namedFromJson(v: Json, what: string): NamedType {
  if (!isObj(v)) throw new SpecError(`invalid ${what}`);
  return {
    name: str(v.name, `${what} name`),
    doc: str(v.doc ?? '', 'doc'),
    type: typeFromJson(v.type),
  };
}

function casesFromJson(v: Json): EnumCase[] {
  if (!Array.isArray(v)) throw new SpecError('enum without cases');
  return v.map((c) => {
    if (!isObj(c)) throw new SpecError('invalid enum case');
    return { name: str(c.name, 'case name'), doc: str(c.doc ?? '', 'doc'), value: Number(c.value) };
  });
}

/**
 * Builds a {@link ContractSpec} from XDR-JSON spec entries.
 *
 * @param entries - values as produced by `ScSpecEntry#toJson()`
 */
export function specFromJsonEntries(entries: readonly Json[]): ContractSpec {
  const spec: ContractSpec = { functions: [], types: {}, events: [] };
  for (const entry of entries) {
    if (!isObj(entry)) throw new SpecError('spec entry must be an object');
    const [key, body] = Object.entries(entry)[0] ?? [];
    if (!isObj(body)) throw new SpecError(`invalid spec entry ${String(key)}`);
    const doc = str(body.doc ?? '', 'doc');
    const lib = str(body.lib ?? '', 'lib');
    switch (key) {
      case 'function_v0': {
        const fn: FunctionSpec = {
          name: str(body.name, 'function name'),
          doc,
          inputs: (Array.isArray(body.inputs) ? body.inputs : []).map((i) =>
            namedFromJson(i, 'input'),
          ),
          outputs: (Array.isArray(body.outputs) ? body.outputs : []).map(typeFromJson),
        };
        spec.functions.push(fn);
        break;
      }
      case 'udt_struct_v0': {
        const name = str(body.name, 'struct name');
        spec.types[name] = {
          kind: 'struct',
          name,
          doc,
          lib,
          fields: (Array.isArray(body.fields) ? body.fields : []).map((f) =>
            namedFromJson(f, 'field'),
          ),
        };
        break;
      }
      case 'udt_union_v0': {
        const name = str(body.name, 'union name');
        const cases: UnionCase[] = (Array.isArray(body.cases) ? body.cases : []).map((c) => {
          if (!isObj(c)) throw new SpecError('invalid union case');
          if (isObj(c.void_v0)) {
            return {
              kind: 'void',
              name: str(c.void_v0.name, 'case'),
              doc: str(c.void_v0.doc ?? '', 'doc'),
            };
          }
          if (isObj(c.tuple_v0)) {
            const types = Array.isArray(c.tuple_v0.type) ? c.tuple_v0.type : [];
            return {
              kind: 'tuple',
              name: str(c.tuple_v0.name, 'case'),
              doc: str(c.tuple_v0.doc ?? '', 'doc'),
              types: types.map(typeFromJson),
            };
          }
          throw new SpecError('invalid union case');
        });
        spec.types[name] = { kind: 'union', name, doc, lib, cases };
        break;
      }
      case 'udt_enum_v0': {
        const name = str(body.name, 'enum name');
        spec.types[name] = { kind: 'enum', name, doc, lib, cases: casesFromJson(body.cases) };
        break;
      }
      case 'udt_error_enum_v0': {
        const name = str(body.name, 'error enum name');
        spec.types[name] = { kind: 'errorEnum', name, doc, lib, cases: casesFromJson(body.cases) };
        break;
      }
      case 'event_v0':
        spec.events.push(str(body.name, 'event name'));
        break;
      default:
        throw new SpecError(`unknown spec entry kind "${String(key)}"`);
    }
  }
  return spec;
}

/** Converts parsed XDR spec entries into a {@link ContractSpec}. */
export function specFromXdrEntries(entries: readonly xdr.ScSpecEntry[]): ContractSpec {
  return specFromJsonEntries(entries.map((e) => e.toJson()));
}

function namedToJson(n: NamedType): Json {
  return { doc: escapeXdrString(n.doc), name: escapeXdrString(n.name), type: typeToJson(n.type) };
}

function udtToJson(t: UdtSpec): Json {
  const base = {
    doc: escapeXdrString(t.doc),
    lib: escapeXdrString(t.lib),
    name: escapeXdrString(t.name),
  };
  switch (t.kind) {
    case 'struct':
      return { udt_struct_v0: { ...base, fields: t.fields.map(namedToJson) } };
    case 'union':
      return {
        udt_union_v0: {
          ...base,
          cases: t.cases.map((c) =>
            c.kind === 'void'
              ? { void_v0: { doc: escapeXdrString(c.doc), name: escapeXdrString(c.name) } }
              : {
                  tuple_v0: {
                    doc: escapeXdrString(c.doc),
                    name: escapeXdrString(c.name),
                    type: c.types.map(typeToJson),
                  },
                },
          ),
        },
      };
    case 'enum':
    case 'errorEnum': {
      const cases = t.cases.map((c) => ({
        doc: escapeXdrString(c.doc),
        name: escapeXdrString(c.name),
        value: c.value,
      }));
      return t.kind === 'enum'
        ? { udt_enum_v0: { ...base, cases } }
        : { udt_error_enum_v0: { ...base, cases } };
    }
  }
}

/**
 * Converts a {@link ContractSpec} back into XDR spec entries (types first,
 * then functions). Events are not round-tripped.
 */
export function specToXdrEntries(spec: ContractSpec): xdr.ScSpecEntry[] {
  const json: Json[] = [
    ...Object.values(spec.types).map(udtToJson),
    ...spec.functions.map((f) => ({
      function_v0: {
        doc: escapeXdrString(f.doc),
        name: escapeXdrString(f.name),
        inputs: f.inputs.map(namedToJson),
        outputs: f.outputs.map(typeToJson),
      },
    })),
  ];
  return json.map((j) => xdr.ScSpecEntry.fromJson(j as xdr.JsonValue));
}
