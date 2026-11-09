# Built-in checks

Every check can be switched off globally (`checks: { "<name>": false }`) or per function (`functions.<name>.checks`). See [configuration.md](configuration.md#checks). Checks that need configuration (`read-only`, `budget`, `cost-regression`, `custom-property`) only run where that configuration exists.

Each per-call check is run as its own fast-check property over the same inputs: boundary cases first, then `runs` random cases from the seed. Simulations are cached, so running six checks does not mean six times the RPC calls. On failure the input is shrunk and the check reports **one finding per function**: the minimal counterexample, the seed, and a replay file. A function with several distinct problems can therefore show one finding per check.

Simulation failures that are not host errors, and transport errors, never fail a check. See [concepts.md](concepts.md#outcome-classification).

## `no-unexpected-trap`

**What it checks:** a function must not trap on inputs that match its declared parameter types.

**How:** a simulation whose error is `Error(Type, Code)` is a trap, unless it is `Error(Contract, #N)` with `N` declared in one of the contract's error enums. That covers Rust panics and `unwrap()` on `None` (`Error(WasmVm, InvalidAction)`), division by zero, arithmetic overflow with `overflow-checks`, budget exhaustion (`Error(Budget, ExceededLimit)`), missing storage, and `panic_with_error!` codes that are not in the spec.

**Enable / tune:** on by default. Disable for a function with `functions.<name>.checks["no-unexpected-trap"] = false` if it is _meant_ to panic on some inputs (better: return a declared error instead).

**Example failure** (the buggy vault's `div_by`):

```text
3) no-unexpected-trap · div_by
   trapped with Error(WasmVm, InvalidAction)
   host: attempt to divide by zero
   counterexample: amount=0  (minimal as found)
```

The `host:` line is the first diagnostic-event payload from the host error, when the RPC includes one.

## `deterministic`

**What it checks:** two simulations of the same input give the same outcome kind, the same return value (or error code), and the same resource numbers: CPU instructions, memory (when reported), read/write footprint sizes, and read/write bytes. The minimum resource fee is not compared, because it depends on network fee settings that can change between ledgers.

**How:** for every input, the cached first simulation is compared with a fresh second one. This doubles the RPC calls for this check.

**Enable / tune:** on by default. Turn it off globally (`checks.deterministic: false`) if your RPC is rate-limited, and back on for important functions.

**Example failure** (the buggy vault's `roll`, which mixes in the PRNG):

```text
1) deterministic · roll
   two simulations of the same input gave different results
   first call:  returned 6912158355717386040
   second call: returned 6912158355717386091
   counterexample: salt=0  (minimal as found)
```

On a real network (stellar-rpc 30) this check caught `env.prng()` use, because each simulation gets a different PRNG seed (verified by `make integration`). It usually cannot catch timestamp- or sequence-dependent logic: two back-to-back simulations normally see the same ledger.

## `read-only`

**What it checks:** a function you mark `readOnly` must not write ledger state. A successful simulation must have an empty read-write footprint.

**How:** the read-write footprint entries in `transactionData` are counted and decoded for the message.

**Enable / tune:**

```json
{ "functions": { "balance": { "readOnly": true }, "get_config": { "readOnly": true } } }
```

**Example failure:**

```text
4) read-only · balance
   function is configured read-only but writes 1 ledger entry: persistent contract data {"symbol":"LastSeen"}
   counterexample: who="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"  (minimal as found)
```

**Caveat:** `require_auth()` on an address other than the transaction source adds a nonce entry to the read-write footprint. Do not mark functions that require auth as read-only.

## `budget`

**What it checks:** each call's CPU instructions (and memory bytes, when the RPC reports them) stay at or below a threshold.

**How:** CPU comes from the legacy `cost.cpuInsns` field when present, otherwise from `transactionData.resources.instructions`, which is what a real transaction would declare. Memory comes only from `cost.memBytes`, which stellar-rpc 30 no longer returns, so memory thresholds are skipped there.

**Enable / tune:** set thresholds globally and/or per function:

```json
{
  "budget": { "cpuInstructions": 20000000 },
  "functions": { "batch_pay": { "budget": { "cpuInstructions": 80000000 } } }
}
```

**Example failure** ([demo-output/fuzz-budget.txt](demo-output/fuzz-budget.txt), using [examples/vault-demo/budget.config.json](../examples/vault-demo/budget.config.json), which sets a 1,200,000-instruction budget on `compute`):

```text
1) budget · compute
   over budget: CPU 1400000 > 1200000 instructions
   counterexample: n=0  (minimal as found)
   seed: 1
```

The input is shrunk to the smallest one that is still over budget, which usually points at the parameter driving the cost (here even `n=0` is over, so the base cost itself is the problem).

## `cost-regression`

**What it checks:** a function's **maximum** CPU instructions (and memory, when reported) over the measurement set must not grow by more than `baseline.thresholdPercent` (default 10%) compared with a saved baseline.

**How:** the measurement set is the function's boundary cases plus `runs` seeded random inputs, and only successful simulations count. With the same seed and runs, both sides measure exactly the same inputs. `costs --update-baseline` writes the baseline (it records the seed and runs). `costs --check-baseline` reuses them. `fuzz` also compares when the baseline file exists, and warns if its seed or runs differ. Growth is `(current - baseline) / baseline × 100`. Improvements beyond the threshold, new functions and removed functions are listed but do not fail.

**Enable / tune:**

```sh
soroban-testkit costs <target> --update-baseline        # on main, commit the baseline file
soroban-testkit costs <target> --check-baseline         # in PRs: exit 1 on regression
soroban-testkit costs <target> --check-baseline --threshold 25
```

**Example failure:**

```text
6) cost-regression · compute
   cost grew beyond 10%: CPU max 1098200 -> 1537480 (+40%)
   costliest input: n=741205982
```

The reported input is the costliest one in the measurement set. It is not shrunk, because a regression is a property of the whole function rather than of one input.

## `custom-property`

**What it checks:** your own invariants, written as `(args, result, ctx) => boolean | string`. See [custom-properties.md](custom-properties.md).

**How:** each property is its own fast-check property on the functions it targets. By default it only sees successful calls (`includeFailures: true` changes that). It can simulate other functions with `ctx.call`. Returning `false` or a string fails, and so does throwing. Transport errors inside a property abort the run instead.

**Enable / tune:** list property files in `properties` or pass `--properties`.

**Example failure:**

```text
5) custom-property · transfer · "balance after transfer is never negative"
   property "balance after transfer is never negative" failed: returned false (result: -1)
   counterexample: from="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", to="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", amount=1001  (shrunk in 121 steps)
```
