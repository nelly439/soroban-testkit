# Concepts

This page explains what soroban-testkit does under the hood, why it is safe to point at any network, and what each check can and cannot catch.

## Simulation

Stellar RPC's `simulateTransaction` method takes an unsigned transaction and runs it against the network's current ledger state. The run uses the real Soroban host, the same one validators use. Then it throws the result away. It returns:

- the function's return value (`results[0].xdr`), or an error string (`HostError: Error(Contract, #3)` ...),
- `transactionData`: the resources a real transaction would need (CPU instructions, the read-only and read-write ledger footprint, bytes read and written),
- `minResourceFee`: the resource fee a real submission would pay,
- diagnostic `events`.

soroban-testkit builds one `invokeHostFunction` transaction per generated input and simulates it.

### Why it is safe

- **Nothing is signed and nothing is submitted.** The tool never calls `sendTransaction` and never needs a secret key.
- **Simulation does not change chain state.** Writes a function performs during simulation are discarded, so you can fuzz a contract on testnet or mainnet without side effects (apart from RPC load; see [troubleshooting](troubleshooting.md#rpc-rate-limits)).
- The default source account is the all-zero account `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`. Simulation does not check that the source account exists or has funds. You can set a real one with `sourceAccount` (see [configuration](configuration.md)).
- Authorization runs in _recording_ mode: `require_auth()` calls succeed and are recorded instead of being checked against signatures. This lets the tool exercise functions that need auth, but it also means **missing authorization checks are not detected by default** (you can write a [custom property](custom-properties.md) for that).

### What simulation cannot tell you

- **State does not persist between calls.** Each simulation starts from current ledger state, so a `transfer` followed by `balance` cannot be tested as a sequence.
- **Ledger-dependent behaviour** (timestamps, sequence numbers, the PRNG) is fixed at simulation time.
- **Memory:** stellar-rpc 30 does not return the legacy `cost.memBytes` field, so memory figures show as `n/a` and memory budgets are skipped. This was verified by `make integration` against stellar-rpc 30.0.0, protocol 30.

## Outcome classification

Every simulation is classified into one of four outcomes:

| outcome             | when                                                                                                                                                                            | counted as a finding?                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `success`           | the function returned a value                                                                                                                                                   | no (but checks inspect it)                                  |
| `contract-error`    | `Error(Contract, #N)` where `N` is declared in the contract's error enum                                                                                                        | no: declared errors are the contract saying "no" on purpose |
| `trap`              | any other host error: wasm trap or Rust panic (`Error(WasmVm, InvalidAction)`), arithmetic overflow, budget exceeded, storage errors, or an error code not declared in the spec | yes, by `no-unexpected-trap`                                |
| `simulation-failed` | the response has an error that is not a host error (malformed request, simulation refused)                                                                                      | no: reported separately as "simulation failures"            |

Transport problems (connection refused, timeouts, HTTP 429/5xx, JSON-RPC errors) are a separate category. They are retried (`retries`, default 2), and then the run aborts with exit code `3`. A transport failure is **never** turned into a finding, even inside a custom property's `ctx.call`.

## Inputs, seeds and shrinking

For every function soroban-testkit builds a [fast-check](https://fast-check.dev) arbitrary from the parameter types ([docs/generators.md](generators.md)) and runs:

1. **Boundary cases first.** All parameters start at their simplest boundary value (0, empty, the all-zero address...). Then each parameter is varied over its own boundary values (min, max, max-1, single-element collections...), and finally every parameter is moved together (all max, all min...).
2. **Then `runs` random cases** (default 100), drawn from the seed.

When a check fails, fast-check **shrinks** the input to a minimal one that still fails (for example `amount=170141183460469231731687303715884105727` shrinks to `amount=1001`). This also works when the failing input was a boundary case.

Every run uses one 32-bit **seed**, printed at the start and in the report. The same seed with the same `runs` and the same contract always produces the same inputs. Each finding is also written to a **replay file** (`.soroban-testkit/replays/<check>--<function>.json`) containing the exact encoded arguments. `fuzz --replay <file>` re-runs exactly that input.

Simulations are cached per distinct input within a run, so the six checks share the work. Only the `deterministic` check (and `ctx.call` in properties) deliberately simulates again.

## The checks

The six built-in checks are summarised here; details, configuration and example failures are in [checks.md](checks.md).

- **`no-unexpected-trap`**: a function must not trap or panic on inputs that match its declared types. Declared contract errors are fine.
  _Cannot catch:_ functions that return a wrong value without trapping, or that reject valid input with a declared error.
- **`deterministic`**: simulating the same input twice must give the same outcome, the same return value and the same resource numbers (CPU, memory if reported, footprint sizes, bytes). The fee is not compared, because it depends on network fee settings.
  _Cannot catch:_ behaviour that only changes between ledgers (two back-to-back simulations usually see the same ledger), or a source of randomness the RPC seeds the same way each time.
- **`read-only`**: a function you mark `readOnly` must have an empty read-write footprint.
  _Cannot catch:_ writes on code paths the generated inputs never reach. Also note that `require_auth()` on an address other than the source account adds a nonce entry to the footprint, so do not mark functions that require auth as read-only.
- **`budget`**: CPU instructions (and memory, when the RPC reports it) of each call must stay under configured thresholds.
  _Cannot catch:_ expensive inputs the generator never produces.
- **`cost-regression`**: the maximum CPU (and memory, when reported) of each function, measured over a fixed set of boundary and seeded random inputs, must not grow more than `thresholdPercent` against a saved baseline.
  _Cannot catch:_ regressions on inputs outside the measured set. Comparisons are only exact when the baseline and the run use the same seed and runs, which `costs --check-baseline` does by default.
- **`custom-property`**: your own `(args, result, ctx) => boolean | string` functions.
  _Cannot catch:_ anything the property does not state.

## Exit codes

| code | meaning                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------- |
| `0`  | ran successfully, no findings                                                                                   |
| `1`  | at least one finding (or a cost regression)                                                                     |
| `2`  | usage or configuration error (bad flag, bad config, unreadable spec, missing contract, every simulation failed) |
| `3`  | the RPC could not be reached or kept failing at the transport level; no findings are reported                   |
