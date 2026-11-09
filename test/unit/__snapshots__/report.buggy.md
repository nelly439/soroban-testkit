## soroban-testkit fuzz: ❌ 5 findings

Contract `CBRHKZ3HPEWXMYLVNR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDL2` · seed `42` · 5 random runs · 87 simulations

| # | check | function | message | counterexample |
|---|---|---|---|---|
| 1 | `no-unexpected-trap` | `div_by` | trapped with Error(WasmVm, InvalidAction) | `amount=0` |
| 2 | `no-unexpected-trap` | `first` | trapped with Error(WasmVm, InvalidAction) | `items=[]` |
| 3 | `read-only` | `balance` | function is configured read-only but writes 1 ledger entry: persistent contract data {"symbol":"LastSeen"} | `who="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"` |
| 4 | `deterministic` | `roll` | two simulations of the same input gave different results | `salt=0` |
| 5 | `cost-regression` | `compute` | cost grew beyond 10%: CPU max 1079400 -> 1511160 (+40%), memory max 269850 -> 377790 (+40%) | `n=1152992794` |

<details><summary>Replay commands</summary>

```sh
soroban-testkit fuzz vault.wasm --replay .soroban-testkit/replays/no-unexpected-trap--div_by.json
soroban-testkit fuzz vault.wasm --replay .soroban-testkit/replays/no-unexpected-trap--first.json
soroban-testkit fuzz vault.wasm --replay .soroban-testkit/replays/read-only--balance.json
soroban-testkit fuzz vault.wasm --replay .soroban-testkit/replays/deterministic--roll.json
soroban-testkit fuzz vault.wasm --replay .soroban-testkit/replays/cost-regression--compute.json
```

</details>

| function | checks | inputs | ok | contract err | trap | cpu max | mem max |
|---|---|---|---|---|---|---|---|
| `div_by` | 3 | 11 | 10 | 0 | 1 | 300,000 | 75,000 |
| `first` | 3 | 9 | 8 | 0 | 1 | 204,000 | 51,000 |
| `balance` | 4 | 9 | 9 | 0 | 0 | 250,000 | 62,500 |
| `roll` | 4 | 9 | 9 | 0 | 0 | 400,000 | 100,000 |
| `compute` | 3 | 9 | 9 | 0 | 0 | 1,511,160 | 377,790 |
| `transfer` | skipped (skipped by config) | 0 | 0 | 0 | 0 | n/a | n/a |

**Baseline** `.soroban-testkit/baseline.json` (threshold 10%)

- regression  compute cpuInstructions: 1,079,400 -> 1,511,160 (+40%)
- regression  compute memoryBytes: 269,850 -> 377,790 (+40%)
- improvement div_by cpuInstructions: 600,000 -> 300,000 (-50%)
- new function (not in baseline): first
- missing function (in baseline, not measured): removed
