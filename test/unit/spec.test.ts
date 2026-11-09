import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contract, StrKey, xdr } from '@stellar/stellar-sdk';
import {
  errorMessage,
  isWasm,
  loadSpecFromFile,
  loadSpecFromJson,
  loadSpecFromWasm,
  resolveTarget,
} from '../../src/spec/load.js';
import {
  escapeXdrString,
  specFromJsonEntries,
  specToXdrEntries,
  typeFromJson,
  typeToJson,
  unescapeXdrString,
} from '../../src/spec/xdr-json.js';
import {
  declaredErrorCodes,
  formatType,
  PRIMITIVE_KINDS,
  type TypeRef,
} from '../../src/spec/types.js';
import { SpecError, UsageError } from '../../src/errors.js';
import { buildWasm, buildWasmFromEntries, uleb128 } from '../fixtures/wasm-builder.js';
import { allTypesSpec } from '../fixtures/specs.js';

const tmp = mkdtempSync(join(tmpdir(), 'stk-spec-'));

describe('wasm builder', () => {
  it('produces modules that WebAssembly.validate accepts', () => {
    const wasm = buildWasm(allTypesSpec);
    expect(isWasm(wasm)).toBe(true);
    const wa = (globalThis as unknown as { WebAssembly: { validate(b: Uint8Array): boolean } })
      .WebAssembly;
    expect(wa.validate(wasm)).toBe(true);
  });

  it('encodes LEB128', () => {
    expect(uleb128(0)).toEqual([0]);
    expect(uleb128(127)).toEqual([127]);
    expect(uleb128(128)).toEqual([0x80, 0x01]);
    expect(uleb128(624485)).toEqual([0xe5, 0x8e, 0x26]);
  });

  it('agrees with the stellar-sdk wasm parser', () => {
    const wasm = buildWasm(allTypesSpec);
    const sdk = contract.Spec.fromWasm(wasm);
    expect(sdk.funcs().map((f) => f.name.toString())).toEqual([
      'primitives',
      'composites',
      'udts',
      'nothing',
    ]);
  });
});

describe('loadSpecFromWasm', () => {
  it('round-trips every spec type through real wasm bytes', () => {
    const spec = loadSpecFromWasm(buildWasm(allTypesSpec));
    expect(spec.functions).toEqual(allTypesSpec.functions);
    expect(spec.types).toEqual(allTypesSpec.types);
  });

  it('covers every primitive kind', () => {
    for (const kind of PRIMITIVE_KINDS) {
      const t: TypeRef = { kind };
      expect(typeFromJson(typeToJson(t))).toEqual(t);
    }
  });

  it('parses event entries by name', () => {
    const event = xdr.ScSpecEntry.fromJson({
      event_v0: {
        doc: '',
        lib: '',
        name: 'transfer',
        prefix_topics: ['transfer'],
        params: [],
        data_format: 'single_value',
      },
    } as xdr.JsonValue);
    const spec = loadSpecFromWasm(buildWasmFromEntries([event, ...specToXdrEntries(allTypesSpec)]));
    expect(spec.events).toEqual(['transfer']);
  });

  it('rejects non-wasm bytes', () => {
    expect(() => loadSpecFromWasm(new Uint8Array([1, 2, 3, 4]))).toThrow(SpecError);
  });

  it('rejects wasm without a spec section', () => {
    const empty = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    expect(() => loadSpecFromWasm(empty)).toThrow(/contractspecv0/);
  });

  it('rejects wasm with two spec sections', () => {
    expect(() => loadSpecFromWasm(buildWasm(allTypesSpec, { specSectionCount: 2 }))).toThrow(
      SpecError,
    );
  });

  it('ignores unrelated custom sections', () => {
    const wasm = buildWasm(allTypesSpec, {
      extraSections: { contractmetav0: new Uint8Array([1, 2, 3]) },
    });
    expect(loadSpecFromWasm(wasm).functions).toHaveLength(4);
  });
});

describe('loadSpecFromJson', () => {
  it('accepts the inspect --json object format', () => {
    const spec = loadSpecFromJson(JSON.stringify(allTypesSpec));
    expect(spec).toEqual(allTypesSpec);
  });

  it('accepts an object wrapping the spec under "spec"', () => {
    expect(loadSpecFromJson(JSON.stringify({ spec: allTypesSpec })).functions).toHaveLength(4);
  });

  it('accepts an array of base64 XDR entries', () => {
    const b64 = specToXdrEntries(allTypesSpec).map((e) => e.toXdr('base64'));
    const spec = loadSpecFromJson(JSON.stringify(b64));
    expect(spec.functions).toEqual(allTypesSpec.functions);
  });

  it('accepts an array of XDR-JSON entries', () => {
    const json = specToXdrEntries(allTypesSpec).map((e) => e.toJson());
    expect(loadSpecFromJson(JSON.stringify(json)).types).toEqual(allTypesSpec.types);
  });

  it('rejects invalid JSON and unknown shapes', () => {
    expect(() => loadSpecFromJson('{nope')).toThrow(/not valid JSON/);
    expect(() => loadSpecFromJson('42')).toThrow(/unrecognised/);
    expect(() => loadSpecFromJson('["!!notbase64"]')).toThrow(SpecError);
    expect(() => loadSpecFromJson('[{"bogus_v0": {}}]')).toThrow(/unknown spec entry/);
    expect(() => specFromJsonEntries([{ function_v0: { name: 1 } }])).toThrow(SpecError);
    expect(() => typeFromJson('u7')).toThrow(/unknown spec type/);
    expect(() => typeFromJson({ wat: {} })).toThrow(/unknown spec type/);
    expect(() => typeFromJson(5)).toThrow(SpecError);
  });
});

describe('loadSpecFromFile / resolveTarget', () => {
  it('detects wasm and JSON by content', async () => {
    const wasmPath = join(tmp, 'c.wasm');
    const jsonPath = join(tmp, 'c.json');
    writeFileSync(wasmPath, buildWasm(allTypesSpec));
    writeFileSync(jsonPath, JSON.stringify(allTypesSpec));
    expect((await loadSpecFromFile(wasmPath)).functions).toHaveLength(4);
    expect((await loadSpecFromFile(jsonPath)).functions).toHaveLength(4);
  });

  it('reports unreadable files as SpecError', async () => {
    await expect(loadSpecFromFile(join(tmp, 'missing.wasm'))).rejects.toThrow(SpecError);
  });

  it('resolves files and contract ids', () => {
    const id = StrKey.encodeContract(Buffer.alloc(32, 7));
    const wasmPath = join(tmp, 'r.wasm');
    writeFileSync(wasmPath, buildWasm(allTypesSpec));
    expect(resolveTarget(id)).toEqual({ kind: 'contract', contractId: id });
    expect(resolveTarget(wasmPath)).toEqual({ kind: 'file', path: wasmPath });
    expect(() => resolveTarget('nope')).toThrow(UsageError);
  });
});

describe('helpers', () => {
  it('escapes and unescapes XDR strings', () => {
    for (const s of ['plain', 'tab\there', 'nl\nr\r', 'nul\0', 'back\\slash', 'é ü 😀', '']) {
      expect(unescapeXdrString(escapeXdrString(s))).toBe(s);
      // and agrees with the SDK's own escaping
      const e = xdr.ScSpecEntry.fromJson({
        function_v0: { doc: escapeXdrString(s), name: 'f', inputs: [], outputs: [] },
      } as xdr.JsonValue);
      expect((e.toJson() as { function_v0: { doc: string } }).function_v0.doc).toBe(
        escapeXdrString(s),
      );
    }
    expect(unescapeXdrString('a\\qb')).toBe('a\\qb');
  });

  it('formats types', () => {
    expect(formatType({ kind: 'vec', element: { kind: 'option', value: { kind: 'u32' } } })).toBe(
      'Vec<Option<u32>>',
    );
    expect(formatType({ kind: 'map', key: { kind: 'symbol' }, value: { kind: 'address' } })).toBe(
      'Map<Symbol, Address>',
    );
    expect(formatType({ kind: 'result', ok: { kind: 'void' }, error: { kind: 'error' } })).toBe(
      'Result<(), Error>',
    );
    expect(formatType({ kind: 'tuple', elements: [{ kind: 'bytes' }, { kind: 'string' }] })).toBe(
      '(Bytes, String)',
    );
    expect(formatType({ kind: 'bytesN', n: 32 })).toBe('BytesN<32>');
    expect(
      ['val', 'bool', 'muxed_address', 'timepoint', 'duration', 'i256'].map((k) =>
        formatType({ kind: k } as TypeRef),
      ),
    ).toEqual(['Val', 'bool', 'MuxedAddress', 'Timepoint', 'Duration', 'i256']);
  });

  it('collects declared error codes', () => {
    expect([...declaredErrorCodes(allTypesSpec)]).toEqual([
      [1, 'Error::NotFound'],
      [2, 'Error::Overflow'],
    ]);
  });

  it('extracts messages from anything thrown', () => {
    expect(errorMessage(new Error('a'))).toBe('a');
    expect(errorMessage({ code: 404, message: 'b' })).toBe('b');
    expect(errorMessage('c')).toBe('c');
  });
});

describe('real compiled example contracts', () => {
  // examples/wasm/*.wasm are built from examples/rust-contracts with soroban-sdk.
  it.each(['vault_clean.wasm', 'vault_buggy.wasm'])('parses %s', async (name) => {
    const spec = await loadSpecFromFile(join(import.meta.dirname, '../../examples/wasm', name));
    expect(spec.functions.map((f) => f.name).sort()).toEqual([
      'balance',
      'compute',
      'div_by',
      'first',
      'roll',
      'transfer',
    ]);
    const transfer = spec.functions.find((f) => f.name === 'transfer')!;
    expect(transfer.inputs.map((i) => formatType(i.type))).toEqual(['Address', 'Address', 'i128']);
    expect(formatType(transfer.outputs[0]!)).toBe('Result<i128, VaultError>');
    expect([...declaredErrorCodes(spec)]).toEqual([
      [1, 'VaultError::DivByZero'],
      [2, 'VaultError::NegativeAmount'],
      [3, 'VaultError::InsufficientBalance'],
    ]);
  });
});
