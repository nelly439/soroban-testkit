# CLI reference

```text
soroban-testkit <command> [options] <target>
```

`<target>` is either:

- a path to a contract `.wasm` file (the spec is read from its `contractspecv0` section),
- a path to a JSON spec file (the output of `inspect --json`, an array of base64 XDR spec entries, or an array of XDR-JSON entries as printed by `stellar contract info interface --output json`), or
- a deployed contract ID (`C...`), whose wasm and spec are downloaded over RPC.

In a clone of this repository the CLI is `node dist/cli.js` (after `npm run build`). Once the package is installed it is `npx soroban-testkit`. All example output on this page was captured by `make demo` against the bundled fake RPC and the example contracts; the raw files are in [docs/demo-output/](demo-output).

Global options:

| flag              | description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `--help`, `-h`    | show help (also works after a command: `soroban-testkit fuzz --help`) |
| `--version`, `-V` | print the version                                                     |

## Exit codes

| code | name           | meaning                                                                                                                                          |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Clean          | the command succeeded and found nothing                                                                                                          |
| `1`  | Findings       | at least one check reported a finding (including cost regressions)                                                                               |
| `2`  | Usage          | bad command line or config, unreadable spec, missing RPC URL, contract not found, or every simulation failed for non-contract reasons            |
| `3`  | RpcUnavailable | the RPC could not be reached or kept failing (connection refused, timeout, HTTP 429/5xx, JSON-RPC error) after retries; no findings are reported |

## Connection options

These options are shared by all three commands (`--contract-id` only by `fuzz` and `costs`). They override the config file and environment variables ([configuration.md](configuration.md)).

| flag                                | description                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `-c, --config <file>`               | config file. Default: the first of `soroban-testkit.config.ts`, `.mjs`, `.js`, `.json` in the current directory                                |
| `--network <name>`                  | preset: `testnet`, `futurenet`, `mainnet`, `local` (sets the RPC URL where one is public, and the passphrase)                                  |
| `--rpc-url <url>`                   | Stellar RPC URL (env `STELLAR_RPC_URL`)                                                                                                        |
| `--network-passphrase <passphrase>` | network passphrase (env `STELLAR_NETWORK_PASSPHRASE`). The tool checks it against the RPC's `getNetwork` and stops with exit `2` on a mismatch |
| `--source-account <account>`        | `G...` source account for simulated transactions (env `STELLAR_SOURCE_ACCOUNT`). Must exist on the network if set                              |
| `--contract-id <id>`                | the deployed contract to call when `<target>` is a local `.wasm` or `.json` file                                                               |

## `soroban-testkit inspect`

```text
soroban-testkit inspect [options] <target>
```

Prints the contract interface: functions with parameter and return types and doc comments, structs, unions, enums, error enums and events. It needs no RPC for file targets.

| flag     | description                                                          |
| -------- | -------------------------------------------------------------------- |
| `--json` | print the spec as JSON. The output can be used as a `<target>` again |

Example ([demo-output/inspect-wasm.txt](demo-output/inspect-wasm.txt)):

```text
$ node dist/cli.js inspect examples/wasm/vault_buggy.wasm
Contract interface: examples/wasm/vault_buggy.wasm
6 functions, 1 type, 0 events

FUNCTIONS
  roll(salt: u32) -> u64
      Derives a number from a salt.
  first(items: Vec<u32>) -> Option<u32>
      Returns the first element, if any.
  div_by(amount: i128) -> Result<i128, VaultError>
      Returns 1_000_000 / amount.
  balance(who: Address) -> i128
      Reads the balance of an account.
  compute(n: u32) -> u64
      Does some arithmetic.
  transfer(from: Address, to: Address, amount: i128) -> Result<i128, VaultError>
      Moves `amount` from `from` to `to`; returns the sender balance after the transfer.

TYPES
  error VaultError { DivByZero = 1, NegativeAmount = 2, InsufficientBalance = 3 }
      Errors returned by the vault.
[exit code 0]
```

With a contract ID the spec comes from the chain: `node dist/cli.js inspect CBRHKZ3HPEWXMYLVNR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDL2 --rpc-url http://127.0.0.1:8787` ([output](demo-output/inspect-contract.txt)).

## `soroban-testkit fuzz`

```text
soroban-testkit fuzz [options] <target>
```

Generates boundary and random inputs for every function, simulates them, and runs every enabled check ([checks.md](checks.md)). Findings are shrunk to minimal counterexamples and written as replay files. Exit `1` if anything was found.

| flag                     | description                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `-n, --runs <n>`         | random cases per function and per check, run after the boundary cases. Default `100`                            |
| `-s, --seed <n>`         | 32-bit seed (0 to 4294967295). Default: random. It is always printed, so any run can be reproduced              |
| `-f, --function <names>` | only test these functions; repeat the flag or separate names with commas                                        |
| `--properties <files>`   | extra custom property files, in addition to the config's `properties`; repeat the flag or separate with commas  |
| `--replay <file>`        | re-run one recorded failure instead of fuzzing. Exit `1` if it still fails, `0` if it no longer does            |
| `--baseline <file>`      | baseline file for `cost-regression`. Default `.soroban-testkit/baseline.json` (or the config's `baseline.path`) |
| `--threshold <percent>`  | allowed cost growth before `cost-regression` fails. Default `10`                                                |
| `--json [file]`          | write a JSON report to `file`; without a file, print JSON to stdout instead of the terminal report              |
| `--markdown [file]`      | same, for Markdown                                                                                              |
| `--junit [file]`         | same, for JUnit XML                                                                                             |
| `--no-color`             | disable ANSI colors (colors are also off when stdout is not a TTY or `NO_COLOR` is set)                         |

Only one of `--json`/`--markdown`/`--junit` can go to stdout. Give the others a file name. Progress lines go to stderr.

Example on the buggy vault ([demo-output/fuzz-buggy.txt](demo-output/fuzz-buggy.txt), abridged):

```text
$ node dist/cli.js fuzz examples/wasm/vault_buggy.wasm --contract-id CBRHKZ3HPEWXMYLVNR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDL2 --config examples/vault-demo/soroban-testkit.config.json --seed 1
soroban-testkit: fuzzing examples/wasm/vault_buggy.wasm with seed 1
  roll: no-unexpected-trap, deterministic, budget, cost-regression
  ...
soroban-testkit 0.1.0 · fuzz · contract CBRHKZ3HPEWXMYLVNR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDL2
seed 1 · 50 random runs per function and check, after boundary cases · reproduce with --seed 1

  function  checks  inputs   ok  contract err  trap  result
  roll           4      51   51             0     0  ✗ 1 finding
  first          4      50   49             0     1  ✗ 1 finding
  div_by         5      54   53             0     1  ✗ 1 finding
  balance        5      54   54             0     0  ✗ 1 finding
  compute        4      51   51             0     0  ✗ 1 finding
  transfer       5     196  170            26     0  ✗ 1 finding

FINDINGS (6)
...
3) no-unexpected-trap · div_by
   trapped with Error(WasmVm, InvalidAction)
   host: attempt to divide by zero
   counterexample: amount=0  (minimal as found)
   seed: 1
   replay: soroban-testkit fuzz examples/wasm/vault_buggy.wasm --replay examples/vault-demo/.soroban-testkit/replays/no-unexpected-trap--div_by.json
...
✗ 6 findings · 745 simulations · 1.6s · seed 1
[exit code 1]
```

`inputs` counts distinct simulated inputs, including the ones tried while shrinking.

Replaying a recorded failure ([demo-output/fuzz-replay.txt](demo-output/fuzz-replay.txt)):

```text
$ node dist/cli.js fuzz examples/wasm/vault_buggy.wasm --contract-id CBRHKZ3HPEWXMYLVNR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDL2 --config examples/vault-demo/soroban-testkit.config.json --replay examples/vault-demo/.soroban-testkit/replays/custom-property--transfer--balance_after_transfer_is_never_negative.json
soroban-testkit 0.1.0 · replay · contract CBRHKZ3HPEWXMYLVNR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDL2
replaying a recorded case (original seed 1)

  function  checks  inputs  ok  contract err  trap  result
  transfer       1       1   1             0     0  ✗ 1 finding

FINDINGS (1)

1) custom-property · transfer · "balance after transfer is never negative"
   property "balance after transfer is never negative" failed: returned false (result: -1)
   counterexample: from="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", to="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", amount=1001  (minimal as found)
   seed: 1

✗ 1 finding · 1 simulations · 0.0s · seed 1
[exit code 1]
```

A replay runs against the target you give. To check that a fix works, replay against the new deployment: exit `0` means the failure is gone. Replaying a `cost-regression` finding re-measures the function with the recorded seed and runs, and needs the baseline file.

The RPC being down ([demo-output/rpc-down.txt](demo-output/rpc-down.txt)):

```text
$ node dist/cli.js fuzz CBRHKZ3HPEWXMYLVNR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDL2 --rpc-url http://127.0.0.1:9 --seed 1
soroban-testkit: fuzzing CBRHKZ3HPEWXMYLVNR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDL2 with seed 1
soroban-testkit: RPC unavailable: RPC getNetwork failed after 3 attempt(s) at http://127.0.0.1:9: fetch failed
This is a transport problem, not a contract bug. No findings were reported.
[exit code 3]
```

Markdown and JUnit output: [demo-output/fuzz-markdown.txt](demo-output/fuzz-markdown.txt), [demo-output/fuzz-junit.txt](demo-output/fuzz-junit.txt).

## `soroban-testkit costs`

```text
soroban-testkit costs [options] <target>
```

Measures CPU instructions, memory (when the RPC reports it), write footprint and minimum resource fee for every function. The measurement set is the boundary cases plus `runs` seeded random inputs, and only successful simulations count. It accepts all the `fuzz` options above except `--properties` and `--replay`, plus:

| flag                | description                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--update-baseline` | write the measured costs to the baseline file (default `.soroban-testkit/baseline.json`). Exit `0`                                                                                                                 |
| `--check-baseline`  | compare with the baseline file. Exit `1` if any function's max CPU (or memory) grew more than the threshold. Uses the baseline's seed and runs unless `--seed`/`--runs` are given, so the same inputs are measured |

Without either flag, `costs` just prints the table. The two flags cannot be combined.

Example ([demo-output/costs-check-baseline.txt](demo-output/costs-check-baseline.txt), abridged), checking the buggy vault against a baseline recorded from the clean one:

```text
$ node dist/cli.js costs CBRHKZ3HPEWXMYLVNR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDL2 --config examples/vault-demo/soroban-testkit.config.json --check-baseline
...
FINDINGS (1)

1) cost-regression · compute
   cost grew beyond 10%: CPU max 1098200 -> 1537480 (+40%)
   costliest input: n=741205982
   seed: 1

COSTS (successful simulations; boundary + seeded random inputs)
  function  samples    cpu max   cpu mean  mem max  fee max (stroops)
  div_by         56    300,000    300,000      n/a              1,280
  first          49    205,000    202,449      n/a              1,271
  balance        54    250,000    250,000      n/a              2,125
  roll           54    400,000    400,000      n/a              1,290
  compute        54  1,537,480  1,445,847      n/a              1,404
  transfer       43    600,000    600,000      n/a              2,110

BASELINE examples/vault-demo/.soroban-testkit/baseline.json (threshold 10%)
  regression  compute cpuInstructions: 1,098,200 -> 1,537,480 (+40%)

✗ 1 finding · 329 simulations · 0.7s · seed 1
[exit code 1]
```

## Reports

| format       | content                                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| terminal     | per-function table, findings with counterexample, seed and replay command, costs, baseline comparison, simulation failures, notes                                                                         |
| `--json`     | the full `RunReport` object ([api.md](api.md#runreport)): every finding with JSON-safe arguments (`{"$bigint": "..."}`, `{"$bytes": "hex"}`), base64 XDR arguments, per-function outcome counts and costs |
| `--markdown` | a findings table and a function table, suitable for a PR comment or `$GITHUB_STEP_SUMMARY`                                                                                                                |
| `--junit`    | one `<testcase>` per function × check (each custom property is its own test case), with failures carrying the message, counterexample, seed and replay command                                            |
