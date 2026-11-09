/**
 * Parsing of raw `simulateTransaction` responses into classified outcomes and
 * resource numbers.
 */
import { xdr } from '@stellar/stellar-sdk';

/** Resource usage reported by a simulation. */
export interface Resources {
  /** CPU instructions consumed (from `cost.cpuInsns`, else `transactionData.resources.instructions`). */
  cpuInstructions: number;
  /** Memory bytes consumed (from `cost.memBytes`); `null` when the RPC does not report it. */
  memoryBytes: number | null;
  /** Number of read-only footprint entries. */
  readEntries: number;
  /** Number of read-write footprint entries. */
  writeEntries: number;
  /** Bytes read from disk (`diskReadBytes`). */
  readBytes: number;
  /** Bytes written (`writeBytes`). */
  writeBytes: number;
  /** Minimum resource fee in stroops, as a decimal string. */
  minResourceFee: string;
  /** Base64 XDR ledger keys of the read-write footprint. */
  writeFootprint: string[];
}

/** The classified result of one simulated invocation. */
export type Outcome =
  | {
      /** The invocation returned a value. */
      kind: 'success';
      /** Base64 XDR of the returned `ScVal`. */
      retvalXdr: string;
    }
  | {
      /** The invocation failed with a contract error code declared in the spec. */
      kind: 'contract-error';
      /** Numeric error code (`Error(Contract, #code)`). */
      code: number;
      /** `ErrorEnum::Case` name from the spec. */
      name: string;
      /** First line of the host error. */
      message: string;
    }
  | {
      /** The invocation trapped: a panic, a wasm trap, a host error, or an undeclared error code. */
      kind: 'trap';
      /** Host error type and code, e.g. `WasmVm, InvalidAction`. */
      error: string;
      /** First line of the host error. */
      message: string;
      /** First diagnostic-event payload of the host error, if any (often the panic message). */
      detail?: string;
    }
  | {
      /** Simulation failed for a reason that is not a host error (malformed request, missing contract, ...). */
      kind: 'simulation-failed';
      message: string;
    };

/** The parsed result of one `simulateTransaction` call. */
export interface SimulationResult {
  outcome: Outcome;
  /** Present when the simulation succeeded. */
  resources: Resources | null;
  /** Ledger the simulation ran against. */
  latestLedger: number;
}

/** Shape of the raw JSON-RPC `simulateTransaction` result fields we read. */
export interface RawSimulation {
  latestLedger?: number;
  error?: string;
  transactionData?: string;
  minResourceFee?: string;
  results?: Array<{ xdr: string; auth?: string[] }>;
  cost?: { cpuInsns?: string | number; memBytes?: string | number };
  restorePreamble?: unknown;
}

const HOST_ERROR = /Error\((\w+), ([^)]*)\)/;

const EVENT_DATA = /data:"((?:[^"\\]|\\.)*)"/;

/** Extracts the first diagnostic-event string payload from a host error, if any. */
export function hostDetail(message: string): string | undefined {
  const m = EVENT_DATA.exec(message);
  return m && m[1] ? m[1] : undefined;
}

/** Extracts the first line of a (possibly multi-line) host error. */
export function firstLine(message: string): string {
  return (
    message
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? message
  );
}

/**
 * Classifies a simulation error string.
 *
 * - `Error(Contract, #N)` with `N` declared in the spec → `contract-error`
 * - any other `Error(Type, Code)` (wasm traps, panics, host errors, undeclared codes) → `trap`
 * - anything else → `simulation-failed`
 *
 * @param message - the `error` field of the simulation response
 * @param declared - declared error codes (code → `Enum::Case`)
 */
export function classifyError(message: string, declared: ReadonlyMap<number, string>): Outcome {
  const m = HOST_ERROR.exec(message);
  if (!m) return { kind: 'simulation-failed', message: firstLine(message) };
  const [, type, code] = m;
  if (type === 'Contract') {
    const n = Number(code!.replace('#', ''));
    const name = declared.get(n);
    if (name !== undefined) {
      return { kind: 'contract-error', code: n, name, message: firstLine(message) };
    }
    return withDetail(
      {
        kind: 'trap',
        error: `Contract, #${n} (not declared in the contract spec)`,
        message: firstLine(message),
      },
      message,
    );
  }
  return withDetail(
    { kind: 'trap', error: `${type}, ${code}`, message: firstLine(message) },
    message,
  );
}

function withDetail(o: Extract<Outcome, { kind: 'trap' }>, message: string): Outcome {
  const detail = hostDetail(message);
  return detail ? { ...o, detail } : o;
}

function num(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Reads resource numbers out of a successful raw simulation. */
export function parseResources(raw: RawSimulation): Resources | null {
  if (!raw.transactionData) return null;
  const data = xdr.SorobanTransactionData.fromXdr(raw.transactionData, 'base64');
  const res = data.resources;
  const fp = res.footprint;
  return {
    cpuInstructions: num(raw.cost?.cpuInsns) ?? Number(res.instructions),
    memoryBytes: num(raw.cost?.memBytes) ?? null,
    readEntries: fp.readOnly.length,
    writeEntries: fp.readWrite.length,
    readBytes: Number(res.diskReadBytes),
    writeBytes: Number(res.writeBytes),
    minResourceFee: String(raw.minResourceFee ?? data.resourceFee),
    writeFootprint: fp.readWrite.map((k) => k.toXdr('base64')),
  };
}

/** Converts a raw simulation response into a {@link SimulationResult}. */
export function parseSimulation(
  raw: RawSimulation,
  declared: ReadonlyMap<number, string>,
): SimulationResult {
  const latestLedger = raw.latestLedger ?? 0;
  if (typeof raw.error === 'string' && raw.error !== '') {
    return { outcome: classifyError(raw.error, declared), resources: null, latestLedger };
  }
  const retval = raw.results?.[0]?.xdr;
  if (retval === undefined) {
    return {
      outcome: { kind: 'simulation-failed', message: 'simulation returned no result' },
      resources: parseResources(raw),
      latestLedger,
    };
  }
  return {
    outcome: { kind: 'success', retvalXdr: retval },
    resources: parseResources(raw),
    latestLedger,
  };
}
