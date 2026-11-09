/**
 * Loading contract specs from wasm bytes, JSON files, or a deployed contract.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { contract, StrKey, xdr } from '@stellar/stellar-sdk';
import { SpecError, UsageError } from '../errors.js';
import type { ContractSpec } from './types.js';
import { specFromJsonEntries, specFromXdrEntries } from './xdr-json.js';

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

/** True if the bytes start with the wasm magic number `\0asm`. */
export function isWasm(bytes: Uint8Array): boolean {
  return WASM_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Parses the `contractspecv0` custom section of a contract wasm.
 *
 * @throws {@link SpecError} if the bytes are not wasm or carry no spec.
 */
export function loadSpecFromWasm(wasm: Uint8Array): ContractSpec {
  if (!isWasm(wasm)) throw new SpecError('not a wasm module (missing \\0asm header)');
  let parsed: contract.Spec;
  try {
    parsed = contract.Spec.fromWasm(wasm);
  } catch (err) {
    throw new SpecError(
      `could not read the contractspecv0 section: ${errorMessage(err)}. ` +
        'Was the contract built with soroban-sdk?',
      { cause: err },
    );
  }
  return specFromXdrEntries(parsed.entries);
}

/**
 * Parses a JSON spec document. Three shapes are accepted:
 *
 * 1. the {@link ContractSpec} object written by `soroban-testkit inspect --json`
 *    (detected by its `functions` array),
 * 2. an array of base64 XDR `ScSpecEntry` strings,
 * 3. an array of XDR-JSON entries (as printed by
 *    `stellar contract info interface --output json`).
 */
export function loadSpecFromJson(text: string): ContractSpec {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new SpecError(`spec file is not valid JSON: ${errorMessage(err)}`, { cause: err });
  }
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    const obj = doc as Partial<ContractSpec> & { spec?: unknown };
    if (obj.spec && typeof obj.spec === 'object') return loadSpecFromJson(JSON.stringify(obj.spec));
    if (Array.isArray(obj.functions)) {
      return { functions: obj.functions, types: obj.types ?? {}, events: obj.events ?? [] };
    }
  }
  if (Array.isArray(doc)) {
    if (doc.every((e) => typeof e === 'string')) {
      try {
        return specFromXdrEntries(
          (doc as string[]).map((e) => xdr.ScSpecEntry.fromXdr(e, 'base64')),
        );
      } catch (err) {
        throw new SpecError(`invalid base64 spec entry: ${errorMessage(err)}`, { cause: err });
      }
    }
    return specFromJsonEntries(doc);
  }
  throw new SpecError(
    'unrecognised JSON spec: expected an object with "functions", ' +
      'an array of base64 XDR entries, or an array of XDR-JSON entries',
  );
}

/** Loads a spec from a `.wasm` or `.json` file (detected by content). */
export async function loadSpecFromFile(path: string): Promise<ContractSpec> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (err) {
    throw new SpecError(`cannot read ${path}: ${errorMessage(err)}`, { cause: err });
  }
  if (isWasm(bytes)) return loadSpecFromWasm(bytes);
  return loadSpecFromJson(new TextDecoder().decode(bytes));
}

/** What a CLI target string refers to. */
export type Target = { kind: 'file'; path: string } | { kind: 'contract'; contractId: string };

/**
 * Interprets a CLI target: an existing file path, or a `C...` contract ID.
 *
 * @throws {@link UsageError} if it is neither.
 */
export function resolveTarget(target: string): Target {
  if (existsSync(target)) return { kind: 'file', path: target };
  if (StrKey.isValidContract(target)) return { kind: 'contract', contractId: target };
  throw new UsageError(`"${target}" is neither an existing file nor a valid contract ID (C...)`);
}

/** Extracts a readable message from anything thrown (including SDK `{code, message}` objects). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}
