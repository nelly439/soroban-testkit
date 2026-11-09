/**
 * Spec fixtures used across the test suite.
 */
import type { ContractSpec, PrimitiveKind, TypeRef } from '../../src/spec/types.js';

const p = (kind: PrimitiveKind): TypeRef => ({ kind });

/** One parameter of every primitive kind that is valid as a contract argument. */
export const ARG_PRIMITIVES: PrimitiveKind[] = [
  'bool',
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

/** A spec exercising every spec type, including all user-defined type kinds. */
export const allTypesSpec: ContractSpec = {
  functions: [
    {
      name: 'primitives',
      doc: 'Takes one argument of every primitive type.',
      inputs: ARG_PRIMITIVES.map((k) => ({ name: `a_${k}`, type: p(k), doc: '' })),
      outputs: [p('void')],
    },
    {
      name: 'composites',
      doc: 'Takes composite arguments.',
      inputs: [
        { name: 'v', type: { kind: 'vec', element: p('u32') }, doc: '' },
        { name: 'm', type: { kind: 'map', key: p('symbol'), value: p('i128') }, doc: '' },
        { name: 'o', type: { kind: 'option', value: p('address') }, doc: '' },
        { name: 'r', type: { kind: 'result', ok: p('u32'), error: p('error') }, doc: '' },
        {
          name: 't',
          type: { kind: 'tuple', elements: [p('u32'), p('bool'), p('symbol')] },
          doc: '',
        },
        { name: 'b', type: { kind: 'bytesN', n: 32 }, doc: '' },
        { name: 'val', type: p('val'), doc: '' },
      ],
      outputs: [{ kind: 'vec', element: p('u32') }],
    },
    {
      name: 'udts',
      doc: 'Takes every kind of user-defined type.',
      inputs: [
        { name: 'point', type: { kind: 'udt', name: 'Point' }, doc: '' },
        { name: 'pair', type: { kind: 'udt', name: 'Pair' }, doc: '' },
        { name: 'kind', type: { kind: 'udt', name: 'Kind' }, doc: '' },
        { name: 'color', type: { kind: 'udt', name: 'Color' }, doc: '' },
        { name: 'code', type: { kind: 'udt', name: 'Error' }, doc: '' },
      ],
      outputs: [
        {
          kind: 'result',
          ok: { kind: 'udt', name: 'Point' },
          error: { kind: 'udt', name: 'Error' },
        },
      ],
    },
    { name: 'nothing', doc: '', inputs: [], outputs: [] },
  ],
  types: {
    Point: {
      kind: 'struct',
      name: 'Point',
      doc: 'A 2D point.',
      lib: '',
      fields: [
        { name: 'x', type: p('i32'), doc: '' },
        { name: 'y', type: p('i32'), doc: '' },
        { name: 'label', type: { kind: 'option', value: p('string') }, doc: '' },
      ],
    },
    Pair: {
      kind: 'struct',
      name: 'Pair',
      doc: 'A tuple struct.',
      lib: '',
      fields: [
        { name: '0', type: p('u64'), doc: '' },
        { name: '1', type: p('bool'), doc: '' },
      ],
    },
    Kind: {
      kind: 'union',
      name: 'Kind',
      doc: '',
      lib: '',
      cases: [
        { kind: 'void', name: 'Empty', doc: '' },
        { kind: 'tuple', name: 'One', doc: '', types: [p('u32')] },
        {
          kind: 'tuple',
          name: 'Nested',
          doc: '',
          types: [{ kind: 'udt', name: 'Point' }, p('symbol')],
        },
      ],
    },
    Color: {
      kind: 'enum',
      name: 'Color',
      doc: '',
      lib: '',
      cases: [
        { name: 'Red', value: 0, doc: '' },
        { name: 'Green', value: 1, doc: '' },
        { name: 'Blue', value: 7, doc: '' },
      ],
    },
    Error: {
      kind: 'errorEnum',
      name: 'Error',
      doc: 'Contract errors.',
      lib: '',
      cases: [
        { name: 'NotFound', value: 1, doc: '' },
        { name: 'Overflow', value: 2, doc: 'Arithmetic overflow é.' },
      ],
    },
  },
  events: [],
};
