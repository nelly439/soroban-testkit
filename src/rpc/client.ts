/**
 * Thin wrapper around `rpc.Server` that builds invocation transactions,
 * calls `simulateTransaction`, and maps transport failures to
 * {@link RpcUnavailableError}.
 */
import type { xdr } from '@stellar/stellar-sdk';
import {
  Account,
  BASE_FEE,
  Contract,
  rpc,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk';
import { ConfigError, RpcUnavailableError, SpecError } from '../errors.js';
import { errorMessage, isWasm, loadSpecFromWasm } from '../spec/load.js';
import type { ContractSpec } from '../spec/types.js';
import { parseSimulation, type RawSimulation, type SimulationResult } from './outcome.js';

/**
 * The account used as transaction source when none is configured. Simulation
 * does not check that the source account exists, so this all-zero key works
 * on every network (the stellar-sdk contract client uses the same trick).
 */
export const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Connection settings for {@link SimulationClient}. */
export interface RpcOptions {
  /** Stellar RPC endpoint, e.g. `https://soroban-testnet.stellar.org`. */
  rpcUrl: string;
  /** Network passphrase, e.g. `Test SDF Network ; September 2015`. */
  networkPassphrase: string;
  /** Source account (G...) for simulated transactions. Defaults to {@link NULL_ACCOUNT}. */
  sourceAccount?: string | undefined;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Retries for transport failures (connection errors, HTTP 429/5xx). Default 2. */
  retries?: number;
  /** Base delay between retries in milliseconds (doubled each retry). Default 250. */
  retryDelayMs?: number;
}

/** Wraps `rpc.Server` for simulation-only use. */
export class SimulationClient {
  /** The underlying SDK server. */
  readonly server: rpc.Server;
  private readonly opts: Required<Omit<RpcOptions, 'sourceAccount'>> & { sourceAccount?: string };
  private account: Account | undefined;
  /** Number of `simulateTransaction` calls made. */
  simulations = 0;

  constructor(options: RpcOptions) {
    this.opts = {
      timeoutMs: 30_000,
      retries: 2,
      retryDelayMs: 250,
      ...options,
      sourceAccount: options.sourceAccount ?? undefined,
    } as SimulationClient['opts'];
    let url: URL;
    try {
      url = new URL(options.rpcUrl);
    } catch {
      throw new ConfigError(`invalid RPC URL "${options.rpcUrl}"`);
    }
    this.server = new rpc.Server(url.toString(), {
      allowHttp: url.protocol === 'http:',
      timeout: this.opts.timeoutMs,
    });
  }

  /** Runs `fn`, retrying transport failures, and converts the final failure to {@link RpcUnavailableError}. */
  private async transport<T>(what: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < this.opts.retries) {
          await new Promise((r) => setTimeout(r, this.opts.retryDelayMs * 2 ** attempt));
        }
      }
    }
    throw new RpcUnavailableError(
      `RPC ${what} failed after ${this.opts.retries + 1} attempt(s) at ${this.opts.rpcUrl}: ${describeTransportError(lastErr)}`,
      { cause: lastErr },
    );
  }

  /**
   * Checks that the RPC answers and serves the configured network.
   *
   * @returns the latest ledger sequence
   * @throws {@link RpcUnavailableError} if the RPC cannot be reached
   * @throws {@link ConfigError} if the RPC's network passphrase differs from the configured one
   */
  async ping(): Promise<number> {
    const network = await this.transport('getNetwork', () => this.server.getNetwork());
    if (network.passphrase && network.passphrase !== this.opts.networkPassphrase) {
      throw new ConfigError(
        `network passphrase mismatch: the RPC at ${this.opts.rpcUrl} serves "${network.passphrase}" ` +
          `but the configured passphrase is "${this.opts.networkPassphrase}". ` +
          'Set networkPassphrase (or STELLAR_NETWORK_PASSPHRASE) to match.',
      );
    }
    const health = await this.transport('getHealth', () => this.server.getHealth());
    return health.latestLedger;
  }

  private async sourceAccount(): Promise<Account> {
    if (this.account) return this.account;
    const id = this.opts.sourceAccount;
    if (!id) {
      this.account = new Account(NULL_ACCOUNT, '0');
      return this.account;
    }
    let found: Account | undefined;
    await this.transport('getAccount', async () => {
      try {
        found = await this.server.getAccount(id);
      } catch (err) {
        // "not found" is an answer, not a transport failure.
        if (/not found/i.test(errorMessage(err))) return;
        throw err;
      }
    });
    if (!found) {
      throw new ConfigError(
        `source account ${id} does not exist on this network. Fund it (for example with friendbot on testnet) or unset the source account to simulate as ${NULL_ACCOUNT}.`,
      );
    }
    this.account = found;
    return found;
  }

  /** Builds the (unsigned) invocation transaction for a contract call. */
  async buildInvocation(contractId: string, fn: string, args: xdr.ScVal[]): Promise<Transaction> {
    const account = await this.sourceAccount();
    // Simulation never consumes the sequence number; rebuild from the same account each time.
    const source = new Account(account.accountId(), account.sequenceNumber());
    return new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.opts.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(fn, ...args))
      .setTimeout(300)
      .build();
  }

  /**
   * Simulates one contract invocation. Never submits anything.
   *
   * @param declared - declared contract error codes, used to classify failures
   * @throws {@link RpcUnavailableError} on transport failure
   */
  async simulate(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
    declared: ReadonlyMap<number, string>,
  ): Promise<SimulationResult> {
    const tx = await this.buildInvocation(contractId, fn, args);
    const raw = (await this.transport('simulateTransaction', () =>
      this.server._simulateTransaction(tx),
    )) as unknown as RawSimulation | undefined;
    this.simulations++;
    if (!raw || typeof raw !== 'object') {
      throw new RpcUnavailableError('RPC returned an empty simulateTransaction result');
    }
    return parseSimulation(raw, declared);
  }

  /**
   * Downloads the contract's wasm and parses its spec.
   *
   * @throws {@link SpecError} if the contract does not exist or has no wasm
   * @throws {@link RpcUnavailableError} on transport failure
   */
  async fetchSpec(contractId: string): Promise<ContractSpec> {
    const wasm = await this.fetchWasm(contractId);
    return loadSpecFromWasm(wasm);
  }

  /** Downloads the contract wasm bytes via `getLedgerEntries`. */
  async fetchWasm(contractId: string): Promise<Uint8Array> {
    let notFound: string | undefined;
    const wasm = await this.transport('getLedgerEntries', async () => {
      try {
        return await this.server.getContractWasmByContractId(contractId);
      } catch (err) {
        const msg = errorMessage(err);
        // SDK rejects with {code, message} objects for "missing" answers.
        if (
          isAnswer(err) ||
          /not found|could not obtain|Stellar Asset Contract|not a wasm/i.test(msg)
        ) {
          notFound = msg;
          return undefined;
        }
        throw err;
      }
    });
    if (!wasm) {
      throw new SpecError(
        `could not load contract ${contractId} from ${this.opts.rpcUrl}: ${notFound ?? 'no wasm returned'}. ` +
          'Check the contract ID and that the RPC URL / network passphrase point at the network it is deployed on.',
      );
    }
    if (!isWasm(wasm)) throw new SpecError(`contract ${contractId} code is not wasm`);
    return wasm;
  }
}

function isAnswer(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    !(err instanceof Error) &&
    'code' in err &&
    (err.code === 404 || err.code === 400)
  );
}

/** Describes HTTP / socket / JSON-RPC errors in one line. */
export function describeTransportError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as {
      code?: unknown;
      message?: unknown;
      response?: { status?: number; statusText?: string };
      cause?: { code?: unknown };
    };
    if (e.response?.status) {
      return `HTTP ${e.response.status}${e.response.statusText ? ` ${e.response.statusText}` : ''}${
        e.response.status === 429 ? ' (rate limited)' : ''
      }`;
    }
    const code =
      typeof e.code === 'string' ? e.code : typeof e.cause?.code === 'string' ? e.cause.code : '';
    const msg = typeof e.message === 'string' ? e.message : '';
    if (typeof e.code === 'number') return `JSON-RPC error ${e.code}: ${msg}`;
    return [code, msg].filter(Boolean).join(': ') || String(err);
  }
  return String(err);
}
