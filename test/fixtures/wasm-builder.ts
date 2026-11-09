/**
 * Builds minimal, valid WebAssembly modules that carry a `contractspecv0`
 * custom section, so spec loading can be tested against real wasm bytes
 * without a Rust toolchain.
 *
 * The produced module has no code; it is only meant to be *parsed*.
 * `WebAssembly.validate()` accepts it.
 */
import { createHash } from 'node:crypto';
import type { xdr } from '@stellar/stellar-sdk';
import { specToXdrEntries } from '../../src/spec/xdr-json.js';
import type { ContractSpec } from '../../src/spec/types.js';

/** Unsigned LEB128 encoding. */
export function uleb128(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

/** Encodes a wasm custom section (id 0) with the given name and payload. */
export function customSection(name: string, payload: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const body = [...uleb128(nameBytes.length), ...nameBytes, ...payload];
  return new Uint8Array([0x00, ...uleb128(body.length), ...body]);
}

/** Options for {@link buildWasm}. */
export interface BuildWasmOptions {
  /** Extra custom sections to append (name -> payload). */
  extraSections?: Record<string, Uint8Array>;
  /** Number of `contractspecv0` sections to emit (default 1; >1 is invalid for Soroban). */
  specSectionCount?: number;
}

/** Builds a wasm module whose `contractspecv0` section holds the given XDR entries. */
export function buildWasmFromEntries(
  entries: readonly xdr.ScSpecEntry[],
  options: BuildWasmOptions = {},
): Uint8Array {
  const payload = concat(entries.map((e) => e.toXdr()));
  const parts: Uint8Array[] = [new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])];
  for (let i = 0; i < (options.specSectionCount ?? 1); i++) {
    parts.push(customSection('contractspecv0', payload));
  }
  for (const [name, data] of Object.entries(options.extraSections ?? {})) {
    parts.push(customSection(name, data));
  }
  return concat(parts);
}

/** Builds a wasm module from a {@link ContractSpec}. */
export function buildWasm(spec: ContractSpec, options: BuildWasmOptions = {}): Uint8Array {
  return buildWasmFromEntries(specToXdrEntries(spec), options);
}

/** SHA-256 of the wasm bytes (the on-chain wasm hash). */
export function wasmHash(wasm: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(wasm).digest());
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
