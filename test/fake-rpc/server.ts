/**
 * A fake Stellar RPC server over real HTTP, for tests and the demo.
 *
 * It implements the JSON-RPC methods soroban-testkit uses
 * (`getHealth`, `getNetwork`, `getLatestLedger`, `getLedgerEntries`,
 * `simulateTransaction`) and hosts "fake contracts": a spec (embedded in a
 * synthetic wasm, served through `getLedgerEntries` exactly like a real
 * contract) plus JavaScript handlers that script each function's behaviour.
 *
 * What this proves: the tool's real HTTP client, transaction building,
 * XDR encoding, response parsing, outcome classification, checks, shrinking,
 * replay and reporting all work end to end against RPC-shaped responses.
 *
 * What it does NOT prove: anything about the real Soroban host (real wasm
 * execution, real metering, real footprints). See `make integration` for that.
 *
 * This is a TEST TOOL. It lives outside `src/` and is not part of the package.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Address,
  Networks,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import type { ContractSpec } from '../../src/spec/types.js';
import { fromScVal, toScVal } from '../../src/generate/scval.js';
import { buildWasm, wasmHash } from '../fixtures/wasm-builder.js';

/** What a fake contract function returns. */
export type FakeResult =
  | { ok: unknown; cost?: FakeCost; writes?: string[]; reads?: string[] }
  | { contractError: number }
  | { trap: string };

/** Scripted resource usage. */
export interface FakeCost {
  cpu: number;
  mem?: number;
}

/** Context passed to fake contract handlers. */
export interface FakeCallContext {
  /** Number of times this function has been simulated before (per server). */
  callCount: number;
}

/** A scripted function implementation; `args` are decoded native values. */
export type FakeHandler = (args: unknown[], ctx: FakeCallContext) => FakeResult;

/** A contract hosted by the fake RPC. */
export interface FakeContract {
  /** Contract ID (C...). */
  id: string;
  /** Contract interface (embedded into a synthetic wasm). */
  spec: ContractSpec;
  /** Function implementations, keyed by function name. */
  handlers: Record<string, FakeHandler>;
}

/** Failure injection for transport-error tests. */
export type FailMode =
  | { kind: 'none' }
  | { kind: 'http-status'; status: number; afterRequests?: number }
  | { kind: 'jsonrpc-error'; afterRequests?: number }
  | { kind: 'hang' };

/** Options for {@link startFakeRpc}. */
export interface FakeRpcOptions {
  contracts: FakeContract[];
  /** Network passphrase reported by `getNetwork`. Default: standalone. */
  networkPassphrase?: string;
  /** Port to listen on (0 = random). */
  port?: number;
  /** Existing accounts (G...) served by `getLedgerEntries`. */
  accounts?: string[];
  /**
   * Include the legacy `cost: { cpuInsns, memBytes }` field in simulation
   * responses. Default false, matching stellar-rpc 30 (verified by
   * `make integration`), which does not return it; CPU is then read from
   * `transactionData` and memory is unavailable.
   */
  reportCost?: boolean;
}

/** A running fake RPC. */
export interface FakeRpc {
  url: string;
  port: number;
  /** Count of requests per JSON-RPC method. */
  requests: Record<string, number>;
  /** Change failure injection at runtime. */
  setFailMode(mode: FailMode): void;
  close(): Promise<void>;
}

/** Deterministic contract ID from a short name. */
export function fakeContractId(name: string): string {
  const seed = Buffer.alloc(32);
  Buffer.from(name).copy(seed);
  return StrKey.encodeContract(seed);
}

const LEDGER = 1000;

function hostError(type: string, code: string, detail: string): string {
  return (
    `HostError: Error(${type}, ${code})\n\n` +
    `Event log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(${type}, ${code})], data:"${detail}"\n`
  );
}

function instanceKey(id: string): xdr.LedgerKey {
  return xdr.LedgerKey.fromJson({
    contract_data: { contract: id, key: 'ledger_key_contract_instance', durability: 'persistent' },
  } as xdr.JsonValue);
}

function dataKey(id: string, symbol: string): xdr.LedgerKey {
  return xdr.LedgerKey.fromJson({
    contract_data: { contract: id, key: { symbol }, durability: 'persistent' },
  } as xdr.JsonValue);
}

/** Starts the fake RPC on 127.0.0.1. */
export async function startFakeRpc(options: FakeRpcOptions): Promise<FakeRpc> {
  const passphrase = options.networkPassphrase ?? Networks.STANDALONE;
  const byId = new Map(options.contracts.map((c) => [c.id, c]));
  const wasmById = new Map(options.contracts.map((c) => [c.id, buildWasm(c.spec)]));
  const wasmByHash = new Map(
    [...wasmById.values()].map((w) => [Buffer.from(wasmHash(w)).toString('hex'), w]),
  );
  const accounts = new Set(options.accounts ?? []);
  const callCounts = new Map<string, number>();
  const requests: Record<string, number> = {};
  let failMode: FailMode = { kind: 'none' };
  let total = 0;

  function ledgerEntries(params: { keys?: string[] }): unknown {
    const entries: unknown[] = [];
    for (const k of params.keys ?? []) {
      const key = xdr.LedgerKey.fromXdr(k, 'base64');
      const json = key.toJson() as Record<string, Record<string, unknown>>;
      let data: xdr.LedgerEntryData | undefined;
      if (json.contract_data && json.contract_data.key === 'ledger_key_contract_instance') {
        const id = String(json.contract_data.contract);
        const wasm = wasmById.get(id);
        if (wasm) {
          data = xdr.LedgerEntryData.fromJson({
            contract_data: {
              ext: 'v0',
              contract: id,
              key: 'ledger_key_contract_instance',
              durability: 'persistent',
              val: {
                contract_instance: {
                  executable: { wasm: Buffer.from(wasmHash(wasm)).toString('hex') },
                  storage: null,
                },
              },
            },
          } as xdr.JsonValue);
        }
      } else if (json.contract_code) {
        const hash = String(json.contract_code.hash);
        const wasm = wasmByHash.get(hash);
        if (wasm) {
          data = xdr.LedgerEntryData.fromJson({
            contract_code: { ext: 'v0', hash, code: Buffer.from(wasm).toString('hex') },
          } as xdr.JsonValue);
        }
      } else if (json.account) {
        const id = String(json.account.account_id);
        if (accounts.has(id)) {
          data = xdr.LedgerEntryData.fromJson({
            account: {
              account_id: id,
              balance: '100000000000',
              seq_num: '4294967296',
              num_sub_entries: 0,
              inflation_dest: null,
              flags: 0,
              home_domain: '',
              thresholds: '01000000',
              signers: [],
              ext: 'v0',
            },
          } as xdr.JsonValue);
        }
      }
      if (data) {
        entries.push({
          key: k,
          xdr: data.toXdr('base64'),
          lastModifiedLedgerSeq: LEDGER - 10,
          liveUntilLedgerSeq: LEDGER + 100_000,
        });
      }
    }
    return { entries, latestLedger: LEDGER };
  }

  function simulate(params: { transaction?: string }): unknown {
    const tx = TransactionBuilder.fromXDR(String(params.transaction), passphrase);
    const op = 'operations' in tx ? tx.operations[0] : undefined;
    const func = op?.type === 'invokeHostFunction' ? op.func : undefined;
    if (!func || func.type !== 'hostFunctionTypeInvokeContract') {
      return {
        error: 'unsupported operation: only invoke_contract is simulated',
        latestLedger: LEDGER,
      };
    }
    const invoke = func.invokeContract;
    const id = Address.fromScAddress(invoke.contractAddress).toString();
    const fnName = String(invoke.functionName);
    const contract = byId.get(id);
    if (!contract) {
      return {
        error: hostError('Storage', 'MissingValue', 'contract instance not found'),
        latestLedger: LEDGER,
      };
    }
    const fn = contract.spec.functions.find((f) => f.name === fnName);
    const handler = contract.handlers[fnName];
    if (!fn || !handler) {
      return {
        error: hostError(
          'WasmVm',
          'MissingValue',
          `trying to invoke non-existent contract function ${fnName}`,
        ),
        latestLedger: LEDGER,
      };
    }
    if (invoke.args.length !== fn.inputs.length) {
      return {
        error: hostError('WasmVm', 'UnexpectedSize', 'wrong number of arguments'),
        latestLedger: LEDGER,
      };
    }
    // Decode each argument and check that it is canonical for its declared type.
    const args: unknown[] = [];
    for (let i = 0; i < fn.inputs.length; i++) {
      const type = fn.inputs[i]!.type;
      const val = invoke.args[i]!;
      const native = fromScVal(type, val, contract.spec);
      let roundTrip: string | undefined;
      try {
        roundTrip = toScVal(type, native, contract.spec).toXdr('base64');
      } catch {
        roundTrip = undefined;
      }
      if (roundTrip !== val.toXdr('base64')) {
        return {
          error: hostError(
            'Value',
            'UnexpectedType',
            `argument ${i} does not match ${JSON.stringify(type)}`,
          ),
          latestLedger: LEDGER,
        };
      }
      args.push(native);
    }
    const countKey = `${id}:${fnName}`;
    const callCount = callCounts.get(countKey) ?? 0;
    callCounts.set(countKey, callCount + 1);
    const result = handler(args, { callCount });
    if ('trap' in result) {
      return {
        error: hostError('WasmVm', 'InvalidAction', result.trap),
        events: [],
        latestLedger: LEDGER,
      };
    }
    if ('contractError' in result) {
      return {
        error: hostError('Contract', `#${result.contractError}`, 'contract error'),
        events: [],
        latestLedger: LEDGER,
      };
    }
    const retType = fn.outputs[0] ?? { kind: 'void' as const };
    const okType = retType.kind === 'result' ? retType.ok : retType;
    const retval = toScVal(okType, result.ok, contract.spec);
    const cpu = result.cost?.cpu ?? 500_000;
    const mem = result.cost?.mem ?? Math.round(cpu / 4);
    const reads = [instanceKey(id), ...(result.reads ?? []).map((s) => dataKey(id, s))];
    const writes = (result.writes ?? []).map((s) => dataKey(id, s));
    const readBytes = 200 + 50 * reads.length;
    const writeBytes = 80 * writes.length;
    const fee = BigInt(Math.ceil(cpu / 10_000) + readBytes + writeBytes * 10 + 1000);
    const data = new SorobanDataBuilder()
      .setReadOnly(reads)
      .setReadWrite(writes)
      .setResources(cpu, readBytes, writeBytes)
      .setResourceFee(fee)
      .build();
    return {
      transactionData: data.toXdr('base64'),
      minResourceFee: fee.toString(),
      events: [],
      results: [{ auth: [], xdr: retval.toXdr('base64') }],
      ...(options.reportCost ? { cost: { cpuInsns: String(cpu), memBytes: String(mem) } } : {}),
      latestLedger: LEDGER,
    };
  }

  function dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'getHealth':
        return {
          status: 'healthy',
          latestLedger: LEDGER,
          oldestLedger: 1,
          ledgerRetentionWindow: 17280,
        };
      case 'getNetwork':
        return { passphrase, protocolVersion: 23 };
      case 'getLatestLedger':
        return { id: 'ab'.repeat(32), protocolVersion: 23, sequence: LEDGER };
      case 'getLedgerEntries':
        return ledgerEntries(params as { keys?: string[] });
      case 'simulateTransaction':
        return simulate(params as { transaction?: string });
      default:
        throw Object.assign(new Error(`method not found: ${method}`), { rpcCode: -32601 });
    }
  }

  function send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const method = String(msg.method);
    requests[method] = (requests[method] ?? 0) + 1;
    total++;
    const mode = failMode;
    if (mode.kind === 'hang') return; // never answer
    if (mode.kind === 'http-status' && total > (mode.afterRequests ?? 0)) {
      send(res, mode.status, { message: `injected HTTP ${mode.status}` });
      return;
    }
    if (mode.kind === 'jsonrpc-error' && total > (mode.afterRequests ?? 0)) {
      send(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: 'injected internal error' },
      });
      return;
    }
    try {
      send(res, 200, { jsonrpc: '2.0', id: msg.id, result: dispatch(method, msg.params ?? {}) });
    } catch (err) {
      const e = err as Error & { rpcCode?: number };
      send(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: e.rpcCode ?? -32603, message: e.message },
      });
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      send(res, 500, { message: String(err) });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    setFailMode(mode) {
      failMode = mode;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
