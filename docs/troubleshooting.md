# Troubleshooting

Each entry gives the message you see, the cause, and the fix. Exit codes are listed in [cli.md](cli.md#exit-codes).

## Unfunded source account

```text
soroban-testkit: error: source account GB... does not exist on this network. Fund it (for example with friendbot on testnet) or unset the source account to simulate as GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF.
```

**Cause:** you set `sourceAccount` / `STELLAR_SOURCE_ACCOUNT` / `--source-account`, and the tool loads that account with `getAccount` before simulating. It does not exist on the network the RPC serves.

**Fix:** you usually do not need a source account at all. Unset it and the tool uses the all-zero account, which simulation accepts without it existing. If you need a real one (for example so that `require_auth` on that account is implicit), fund it: on testnet, `curl "https://friendbot.stellar.org?addr=GB..."`. Exit code `2`.

## Wrong network passphrase

```text
soroban-testkit: error: network passphrase mismatch: the RPC at https://... serves "Test SDF Network ; September 2015" but the configured passphrase is "Standalone Network ; February 2017". Set networkPassphrase (or STELLAR_NETWORK_PASSPHRASE) to match.
```

**Cause:** the transaction's network passphrase is part of what gets hashed. The tool compares your passphrase with the RPC's `getNetwork` answer before doing anything.

**Fix:** use `--network testnet` (or `futurenet`, `mainnet`, `local`), or set `networkPassphrase` / `STELLAR_NETWORK_PASSPHRASE` to the string in the message. The default is the standalone passphrase. Exit code `2`.

## Simulation errors versus contract errors

The report separates three kinds of failure ([concepts.md](concepts.md#outcome-classification)):

| you see                                                                | what it is                                                                                                                  | is it a finding?                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `contract err` column counts, no finding                               | `Error(Contract, #N)` with `N` declared in the spec: the contract rejected the input on purpose                             | no                                                                                                                          |
| `trapped with Error(WasmVm, InvalidAction)`                            | a panic or wasm trap: `unwrap()` on `None`, division by zero, overflow, `panic!`                                            | yes (`no-unexpected-trap`)                                                                                                  |
| `trapped with Error(Contract, #7 (not declared in the contract spec))` | the contract raised an error code that is not in its error enum (for example via `panic_with_error!` with a different enum) | yes. Declare the code, or the contract has a bug                                                                            |
| `trapped with Error(Budget, ExceededLimit)`                            | the call ran out of CPU or memory budget for a single transaction                                                           | yes. Some inputs make the function too expensive to ever succeed                                                            |
| `trapped with Error(Storage, MissingValue)` on **every** call          | usually the contract ID is wrong or not deployed on this network                                                            | fix the contract ID / RPC URL. If the contract is missing, `fuzz <contractId>` stops earlier with "could not load contract" |
| `SIMULATION FAILURES (not contract bugs, not counted as findings)`     | the RPC answered with an error that is not a host error                                                                     | not a finding. Read the message; it is usually a malformed or rejected request                                              |

If **every** simulation fails for non-contract reasons, the tool stops with exit code `2` and prints the first error, because a run in which nothing could be tested should not look like a clean pass.

## "simulation needs a deployed contract"

```text
soroban-testkit: error: contract.wasm is a local file; simulation needs a deployed contract. Pass --contract-id <C...> ...
```

**Cause:** simulation calls a contract that exists on a network. A local `.wasm` gives the interface only.

**Fix:** deploy it (for example `stellar contract deploy --wasm contract.wasm ...` on a local network or testnet) and pass `--contract-id`, or pass the contract ID as the target. If the local wasm's function list differs from the deployed one, the report carries a note.

## RPC rate limits

```text
soroban-testkit: RPC unavailable: RPC simulateTransaction failed after 3 attempt(s) at https://...: HTTP 429 Too Many Requests (rate limited)
This is a transport problem, not a contract bug. No findings were reported.
```

**Cause:** public RPC endpoints throttle bursts. One `fuzz` run makes roughly `functions × (boundary cases + runs)` simulations, about twice that with `deterministic` on, plus more while shrinking.

**Fix:**

- lower `--runs` (start with 25 to 50),
- disable `deterministic` globally (`"checks": { "deterministic": false }`) and enable it only for important functions,
- restrict to some functions with `--function`,
- raise `retries` and `timeoutMs` in the config,
- run against your own RPC or a local `stellar/quickstart` network.

Exit code `3`. Re-running is safe: with the same `--seed`, the same inputs are tested.

## Connection refused / timeouts

`RPC unavailable: ... ECONNREFUSED` or `timeout of 30000 ms exceeded` means the URL is wrong or the RPC is down. Check `--rpc-url` (quickstart's RPC is at `http://localhost:8000/rpc`, note the `/rpc` path). The tool retries `retries` times (default 2) with backoff, then exits `3`.

## Large integers

- **In reports**, `u64`/`i64`/`u128`/`i128`/`u256`/`i256` values are printed in full decimal (`amount=170141183460469231731687303715884105727`), and in JSON as `{"$bigint": "..."}` so no precision is lost.
- **In properties**, these types arrive as JavaScript `bigint`. Compare with bigint literals: `result >= 0n`, not `result >= 0`. Mixing `bigint` and `number` in arithmetic throws a `TypeError`, which is reported as `property "..." threw: Cannot mix BigInt and other types, use explicit conversions`.
- `u32`/`i32` arrive as `number`.
- `JSON.stringify` cannot serialize bigints. Use `String(x)` in messages.

## A check I expected did not run

The progress lines on stderr list the checks per function (`transfer: no-unexpected-trap, deterministic, ...`). Some checks need configuration ([checks.md](checks.md)):

- `read-only` needs `functions.<name>.readOnly: true`,
- `budget` needs a threshold,
- `cost-regression` needs a baseline file (a note says where it looked),
- `custom-property` needs a property whose `function` matches. A property naming an unknown function produces a note.

## Memory shows `n/a`

stellar-rpc 30 no longer returns the `cost` field with memory bytes. CPU is taken from `transactionData`, and memory budgets and regressions are skipped. This is a limitation of the RPC response, not a configuration problem.

## Config file not picked up

The CLI only looks in the **current directory** for `soroban-testkit.config.{ts,mjs,js,json}`. Use `--config path/to/file`. Paths inside the config resolve relative to the config file. TypeScript configs are compiled with tsx; a syntax error there is reported as `cannot load config ...` with exit code `2`.
