## soroban-testkit fuzz: ✅ no findings

Contract `CBRWYZLBNYWXMYLVNR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4DZ` · seed `42` · 5 random runs · 95 simulations

| function | checks | inputs | ok | contract err | trap | cpu max | mem max |
|---|---|---|---|---|---|---|---|
| `div_by` | 2 | 11 | 10 | 1 | 0 | 300,000 | 75,000 |
| `first` | 2 | 9 | 9 | 0 | 0 | 204,000 | 51,000 |
| `balance` | 3 | 9 | 9 | 0 | 0 | 250,000 | 62,500 |
| `roll` | 2 | 9 | 9 | 0 | 0 | 400,000 | 100,000 |
| `compute` | 2 | 9 | 9 | 0 | 0 | 1,079,400 | 269,850 |
| `transfer` | skipped (skipped by config) | 0 | 0 | 0 | 0 | n/a | n/a |

**Notes**

- cost-regression skipped: no baseline at .soroban-testkit/baseline.json (create one with "soroban-testkit costs <target> --update-baseline")
