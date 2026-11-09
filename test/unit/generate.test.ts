import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { StrKey, xdr } from '@stellar/stellar-sdk';
import {
  arbitraryFor,
  argumentsArbitrary,
  BOUNDARY_ADDRESSES,
  boundaryCases,
  boundaryValues,
  combineBoundaries,
  DEFAULT_GENERATOR_OPTIONS,
  INT_RANGES,
  MAX_SYMBOL_LENGTH,
} from '../../src/generate/arbitraries.js';
import {
  compareScVal,
  fromScVal,
  sortedMap,
  toScVal,
  argsToScVals,
} from '../../src/generate/scval.js';
import { formatArgs, formatValue, fromJsonSafe, toJsonSafe } from '../../src/generate/format.js';
import type { ContractSpec, FunctionSpec, TypeRef } from '../../src/spec/types.js';
import { SpecError } from '../../src/errors.js';
import { allTypesSpec, ARG_PRIMITIVES } from '../fixtures/specs.js';

const spec = allTypesSpec;
const opts = DEFAULT_GENERATOR_OPTIONS;

const ALL_ARG_TYPES: TypeRef[] = [
  ...ARG_PRIMITIVES.map((kind) => ({ kind }) as TypeRef),
  ...spec.functions[1]!.inputs.map((i) => i.type),
  ...spec.functions[2]!.inputs.map((i) => i.type),
  { kind: 'void' },
  { kind: 'error' },
];

function inRange(kind: string, v: unknown): boolean {
  const r = INT_RANGES[kind]!;
  const b = BigInt(v as bigint);
  return b >= r.min && b <= r.max;
}

describe('arbitraryFor', () => {
  it('produces values that encode to valid ScVals and decode back, for every type', () => {
    for (const type of ALL_ARG_TYPES) {
      fc.assert(
        fc.property(arbitraryFor(type, spec, opts), (v) => {
          const sc = toScVal(type, v, spec);
          const bytes = sc.toXdr();
          const again = xdr.ScVal.fromXdr(bytes);
          const decoded = fromScVal(type, again, spec);
          if (type.kind === 'result') {
            // Result decodes as the Ok type; only compare Ok values.
            const r = v as { ok?: unknown };
            if ('ok' in r)
              expect(toScVal(type, { ok: decoded }, spec).toXdr('base64')).toBe(sc.toXdr('base64'));
            return;
          }
          if (type.kind === 'map') {
            // Maps are re-ordered by key when encoded; compare encodings.
            expect(toScVal(type, decoded, spec).toXdr('base64')).toBe(sc.toXdr('base64'));
            return;
          }
          if (type.kind === 'val') return;
          expect(toScVal(type, decoded, spec).toXdr('base64')).toBe(sc.toXdr('base64'));
        }),
        { numRuns: 60, seed: 42 },
      );
    }
  });

  it('respects integer ranges', () => {
    for (const kind of Object.keys(INT_RANGES)) {
      fc.assert(
        fc.property(arbitraryFor({ kind } as TypeRef, spec), (v) => inRange(kind, v)),
        {
          numRuns: 200,
          seed: 1,
        },
      );
    }
  });

  it('respects symbol charset and length limits', () => {
    fc.assert(
      fc.property(
        arbitraryFor({ kind: 'symbol' }, spec),
        (s) => /^[A-Za-z0-9_]*$/.test(s as string) && (s as string).length <= MAX_SYMBOL_LENGTH,
      ),
      { seed: 3 },
    );
  });

  it('respects collection and bytesN sizes', () => {
    const small = { ...opts, maxCollectionLength: 2, maxBytesLength: 3 };
    fc.assert(
      fc.property(
        arbitraryFor({ kind: 'vec', element: { kind: 'u32' } }, spec, small),
        arbitraryFor({ kind: 'bytes' }, spec, small),
        arbitraryFor({ kind: 'bytesN', n: 7 }, spec, small),
        arbitraryFor({ kind: 'map', key: { kind: 'u32' }, value: { kind: 'bool' } }, spec, small),
        (v, b, bn, m) => {
          const keys = (m as [number, boolean][]).map((e) => e[0]);
          return (
            (v as unknown[]).length <= 2 &&
            (b as Uint8Array).length <= 3 &&
            (bn as Uint8Array).length === 7 &&
            new Set(keys).size === keys.length
          );
        },
      ),
      { seed: 5 },
    );
  });

  it('generates valid addresses of both kinds and uses configured addresses', () => {
    const extra = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 9));
    const samples = fc.sample(
      arbitraryFor({ kind: 'address' }, spec, { ...opts, addresses: [extra] }),
      {
        numRuns: 300,
        seed: 9,
      },
    ) as string[];
    expect(samples.some((s) => s.startsWith('G'))).toBe(true);
    expect(samples.some((s) => s.startsWith('C'))).toBe(true);
    expect(samples).toContain(extra);
  });

  it('stops recursing at maxDepth', () => {
    const recursive: ContractSpec = {
      functions: [],
      events: [],
      types: {
        Tree: {
          kind: 'union',
          name: 'Tree',
          doc: '',
          lib: '',
          cases: [
            { kind: 'void', name: 'Leaf', doc: '' },
            {
              kind: 'tuple',
              name: 'Node',
              doc: '',
              types: [{ kind: 'vec', element: { kind: 'udt', name: 'Tree' } }],
            },
          ],
        },
      },
    };
    const t: TypeRef = { kind: 'udt', name: 'Tree' };
    const samples = fc.sample(arbitraryFor(t, recursive, { ...opts, maxDepth: 2 }), {
      numRuns: 50,
      seed: 2,
    });
    for (const s of samples) toScVal(t, s, recursive);
    expect(boundaryValues(t, recursive, { ...opts, maxDepth: 0 })).toEqual([
      { tag: 'Leaf', values: [] },
    ]);
  });

  it('is deterministic for a given seed', () => {
    const fn = spec.functions[1]!;
    const a = fc.sample(argumentsArbitrary(fn, spec), { numRuns: 20, seed: 123 });
    const b = fc.sample(argumentsArbitrary(fn, spec), { numRuns: 20, seed: 123 });
    const c = fc.sample(argumentsArbitrary(fn, spec), { numRuns: 20, seed: 124 });
    expect(formatValue(a)).toBe(formatValue(b));
    expect(formatValue(a)).not.toBe(formatValue(c));
  });

  it('throws for undefined user types', () => {
    expect(() => arbitraryFor({ kind: 'udt', name: 'Nope' }, spec)).toThrow(SpecError);
  });
});

describe('boundaryValues', () => {
  it('starts integers at 0 and includes min/max edges', () => {
    expect(boundaryValues({ kind: 'u32' }, spec)).toEqual([0, 1, 4294967295, 4294967294]);
    expect(boundaryValues({ kind: 'i32' }, spec)).toEqual([
      0, 1, 2147483647, 2147483646, -2147483648, -2147483647, -1,
    ]);
    const i128 = boundaryValues({ kind: 'i128' }, spec);
    expect(i128).toEqual([
      0n,
      1n,
      2n ** 127n - 1n,
      2n ** 127n - 2n,
      -(2n ** 127n),
      -(2n ** 127n) + 1n,
      -1n,
    ]);
    expect(boundaryValues({ kind: 'u256' }, spec)).toContain(2n ** 256n - 1n);
  });

  it('includes empty and single-element collections', () => {
    expect(boundaryValues({ kind: 'vec', element: { kind: 'u32' } }, spec)).toEqual([
      [],
      [0],
      [1],
      [4294967295],
    ]);
    expect(
      boundaryValues({ kind: 'map', key: { kind: 'symbol' }, value: { kind: 'u32' } }, spec),
    ).toEqual([[], [['', 0]], [['a', 0]]]);
    expect(boundaryValues({ kind: 'string' }, spec)[0]).toBe('');
    expect((boundaryValues({ kind: 'bytes' }, spec)[0] as Uint8Array).length).toBe(0);
    expect(boundaryValues({ kind: 'symbol' }, spec)).toContain('a'.repeat(32));
    expect(boundaryValues({ kind: 'option', value: { kind: 'bool' } }, spec)).toEqual([
      null,
      false,
      true,
    ]);
  });

  it('covers every enum case, union case and boundary address', () => {
    expect(boundaryValues({ kind: 'udt', name: 'Color' }, spec)).toEqual([0, 1, 7]);
    expect(boundaryValues({ kind: 'udt', name: 'Error' }, spec)).toEqual([1, 2]);
    const kinds = boundaryValues({ kind: 'udt', name: 'Kind' }, spec) as { tag: string }[];
    expect(new Set(kinds.map((k) => k.tag))).toEqual(new Set(['Empty', 'One', 'Nested']));
    expect(boundaryValues({ kind: 'address' }, spec)).toEqual(BOUNDARY_ADDRESSES);
  });

  it('produces encodable values for every type', () => {
    for (const type of ALL_ARG_TYPES) {
      const values = boundaryValues(type, spec);
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) expect(() => toScVal(type, v, spec)).not.toThrow();
    }
  });
});

describe('combineBoundaries / boundaryCases', () => {
  it('orders: all-first, then one position varied, then diagonal', () => {
    expect(
      combineBoundaries(
        [
          [0, 1, 2],
          ['a', 'b'],
        ],
        100,
      ),
    ).toEqual([
      [0, 'a'],
      [1, 'a'],
      [2, 'a'],
      [0, 'b'],
      [1, 'b'],
      [2, 'b'],
    ]);
    expect(combineBoundaries([], 10)).toEqual([[]]);
  });

  it('caps the number of cases', () => {
    const fn = spec.functions[0]!;
    expect(boundaryCases(fn, spec, { ...opts, maxBoundaryCases: 10 })).toHaveLength(10);
    expect(boundaryCases(spec.functions[3]!, spec)).toEqual([[]]);
  });
});

describe('shrinking', () => {
  // A function with mapped arbitraries (addresses) and a big integer: the
  // failing boundary example (i128::MAX) must still shrink to the minimum.
  const fn: FunctionSpec = {
    name: 'transfer',
    doc: '',
    inputs: [
      { name: 'from', type: { kind: 'address' }, doc: '' },
      { name: 'to', type: { kind: 'address' }, doc: '' },
      { name: 'amount', type: { kind: 'i128' }, doc: '' },
    ],
    outputs: [{ kind: 'i128' }],
  };

  it('shrinks failing boundary examples to a minimal counterexample', () => {
    const examples = boundaryCases(fn, spec).map((c) => [c] as [unknown[]]);
    const out = fc.check(
      fc.property(argumentsArbitrary(fn, spec), (args) => 1000n - (args[2] as bigint) >= 0n),
      { examples, seed: 1, numRuns: 50 },
    );
    expect(out.failed).toBe(true);
    expect(out.counterexample![0]![2]).toBe(1001n);
    expect(out.counterexample![0]![0]).toBe(BOUNDARY_ADDRESSES[0]);
  });

  it('shrinks random vectors to the empty vector', () => {
    const out = fc.check(
      fc.property(
        arbitraryFor({ kind: 'vec', element: { kind: 'u32' } }, spec),
        (v) => (v as number[]).length > 0,
      ),
      { seed: 4 },
    );
    expect(out.counterexample![0]).toEqual([]);
  });
});

describe('scval helpers', () => {
  it('sorts map keys like the host', () => {
    const m = sortedMap([
      [xdr.ScVal.scvU32(10), xdr.ScVal.scvVoid()],
      [xdr.ScVal.scvU32(2), xdr.ScVal.scvVoid()],
    ]);
    expect(
      fromScVal({ kind: 'map', key: { kind: 'u32' }, value: { kind: 'void' } }, m, spec),
    ).toEqual([
      [2, null],
      [10, null],
    ]);
    const i = (n: bigint): xdr.ScVal => toScVal({ kind: 'i128' }, n, spec);
    expect(compareScVal(i(-5n), i(3n))).toBeLessThan(0);
    expect(compareScVal(xdr.ScVal.scvSymbol('b'), xdr.ScVal.scvSymbol('ab'))).toBeGreaterThan(0);
    expect(compareScVal(xdr.ScVal.scvBool(true), xdr.ScVal.scvU32(0))).toBeLessThan(0);
    expect(compareScVal(xdr.ScVal.scvBool(false), xdr.ScVal.scvBool(true))).toBeLessThan(0);
    const vec = (...n: number[]): xdr.ScVal => xdr.ScVal.scvVec(n.map((x) => xdr.ScVal.scvU32(x)));
    expect(compareScVal(vec(1, 2), vec(1, 3))).toBeLessThan(0);
    expect(compareScVal(vec(1), vec(1, 0))).toBeLessThan(0);
    const a = toScVal({ kind: 'address' }, BOUNDARY_ADDRESSES[0], spec);
    const c = toScVal({ kind: 'address' }, BOUNDARY_ADDRESSES[1], spec);
    expect(compareScVal(a, c)).toBeLessThan(0);
  });

  it('encodes structs as sorted maps, tuple structs as vectors, unions as vectors', () => {
    const point = toScVal(
      { kind: 'udt', name: 'Point' },
      { y: 1, x: 2, label: null },
      spec,
    ).toJson();
    expect(point).toEqual({
      map: [
        { key: { symbol: 'label' }, val: 'void' },
        { key: { symbol: 'x' }, val: { i32: 2 } },
        { key: { symbol: 'y' }, val: { i32: 1 } },
      ],
    });
    expect(toScVal({ kind: 'udt', name: 'Pair' }, { 0: 5n, 1: true }, spec).toJson()).toEqual({
      vec: [{ u64: '5' }, { bool: true }],
    });
    expect(
      toScVal({ kind: 'udt', name: 'Kind' }, { tag: 'One', values: [3] }, spec).toJson(),
    ).toEqual({
      vec: [{ symbol: 'One' }, { u32: 3 }],
    });
    expect(toScVal({ kind: 'udt', name: 'Error' }, 2, spec).toJson()).toEqual({
      error: { contract: 2 },
    });
    expect(toScVal({ kind: 'udt', name: 'Color' }, 7, spec).toJson()).toEqual({ u32: 7 });
  });

  it('rejects values of the wrong shape', () => {
    const bad: [TypeRef, unknown][] = [
      [{ kind: 'bool' }, 1],
      [{ kind: 'u32' }, 'x'],
      [{ kind: 'i32' }, 'x'],
      [{ kind: 'i128' }, 'x'],
      [{ kind: 'symbol' }, 1],
      [{ kind: 'string' }, 1],
      [{ kind: 'bytes' }, 'x'],
      [{ kind: 'address' }, 1],
      [{ kind: 'error' }, 'x'],
      [{ kind: 'val' }, 1],
      [{ kind: 'result', ok: { kind: 'u32' }, error: { kind: 'error' } }, 3],
      [{ kind: 'vec', element: { kind: 'u32' } }, 3],
      [{ kind: 'map', key: { kind: 'u32' }, value: { kind: 'u32' } }, 3],
      [{ kind: 'map', key: { kind: 'u32' }, value: { kind: 'u32' } }, [[1]]],
      [{ kind: 'tuple', elements: [{ kind: 'u32' }] }, [1, 2]],
      [{ kind: 'udt', name: 'Point' }, 3],
      [{ kind: 'udt', name: 'Color' }, 'x'],
      [{ kind: 'udt', name: 'Error' }, 'x'],
      [
        { kind: 'udt', name: 'Kind' },
        { tag: 'Nope', values: [] },
      ],
      [{ kind: 'udt', name: 'Missing' }, 1],
    ];
    for (const [t, v] of bad)
      expect(() => toScVal(t, v, spec), JSON.stringify(t)).toThrow(SpecError);
  });

  it('falls back to generic decoding when the value does not match the type', () => {
    expect(fromScVal({ kind: 'u32' }, xdr.ScVal.scvBool(true), spec)).toBe(true);
    expect(fromScVal({ kind: 'val' }, xdr.ScVal.scvU32(4), spec)).toBe(4);
    expect(
      fromScVal({ kind: 'option', value: { kind: 'u32' } }, xdr.ScVal.scvVoid(), spec),
    ).toBeNull();
    expect(fromScVal({ kind: 'udt', name: 'Point' }, xdr.ScVal.scvMap([]), spec)).toEqual({});
  });

  it('encodes whole argument lists', () => {
    expect(
      argsToScVals([{ kind: 'u32' }, { kind: 'bool' }], [1, true], spec).map((v) => v.type),
    ).toEqual(['scvU32', 'scvBool']);
  });
});

describe('format', () => {
  it('formats values compactly', () => {
    expect(formatValue([1, 2n, 'a', new Uint8Array([0, 255]), null, true])).toBe(
      '[1, 2, "a", 0x00ff, null, true]',
    );
    expect(formatValue({ tag: 'One', values: [5] })).toBe('One(5)');
    expect(formatValue({ tag: 'Leaf', values: [] })).toBe('Leaf');
    expect(formatValue({ x: 1, y: { $type: 'u32', value: 3 } })).toBe('{ x: 1, y: 3_u32 }');
    expect(formatValue(undefined)).toBe('null');
    expect(formatValue(Symbol.for('s'))).toBe('Symbol(s)');
    expect(formatArgs(['a', 'b'], [1, 'x'])).toBe('a=1, b="x"');
  });

  it('round-trips JSON-safe values', () => {
    const v = { a: [1n, new Uint8Array([1, 2]), 'x', null, true], b: { c: -5n } };
    const json = JSON.parse(JSON.stringify(toJsonSafe(v)));
    expect(fromJsonSafe(json)).toEqual(v);
    expect(toJsonSafe(undefined)).toBeNull();
    expect(fromJsonSafe(undefined)).toBeNull();
  });
});
