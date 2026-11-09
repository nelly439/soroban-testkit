# Configuration

soroban-testkit reads, from highest to lowest precedence:

1. command-line flags ([cli.md](cli.md)),
2. environment variables,
3. a config file,
4. the `network` preset,
5. built-in defaults.

## Config file

The CLI looks in the current directory for the first of:

1. `soroban-testkit.config.ts` (compiled on the fly with [tsx](https://tsx.is))
2. `soroban-testkit.config.mjs`
3. `soroban-testkit.config.js` (ESM)
4. `soroban-testkit.config.json`

`--config <file>` picks a file explicitly. JS/TS configs must `export default` the config object. Unknown keys are rejected with exit code `2`, so typos do not go unnoticed. Relative paths inside the file (`properties`, `replayDir`, `baseline.path`) are resolved **relative to the config file**. `--baseline` on the command line is relative to the current directory.

```ts
// soroban-testkit.config.ts
import { defineConfig } from 'soroban-testkit';

export default defineConfig({
  network: 'testnet',
  runs: 200,
  functions: {
    balance: { readOnly: true },
    transfer: { budget: { cpuInstructions: 5_000_000 } },
    upgrade: { skip: true },
  },
  baseline: { thresholdPercent: 5 },
  properties: ['./properties/token.ts'],
});
```

The same config as JSON (this is [examples/vault-demo/soroban-testkit.config.json](../examples/vault-demo/soroban-testkit.config.json), used by the quickstart):

```json
{
  "rpcUrl": "http://127.0.0.1:8787",
  "networkPassphrase": "Standalone Network ; February 2017",
  "runs": 50,
  "functions": {
    "balance": { "readOnly": true },
    "div_by": { "readOnly": true }
  },
  "budget": { "cpuInstructions": 100000000 },
  "baseline": { "path": ".soroban-testkit/baseline.json", "thresholdPercent": 10 },
  "properties": ["properties.ts"]
}
```

## Options

### Connection

| option              | type                                               | default                                                   | description                                                                                                                              |
| ------------------- | -------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `network`           | `"testnet" \| "futurenet" \| "mainnet" \| "local"` | none                                                      | preset for `rpcUrl` and `networkPassphrase` (see below)                                                                                  |
| `rpcUrl`            | string                                             | from `network`, else none                                 | Stellar RPC endpoint. Required for `fuzz`, `costs`, and `inspect <contractId>`                                                           |
| `networkPassphrase` | string                                             | from `network`, else `Standalone Network ; February 2017` | must match the RPC's network; checked with `getNetwork` before any simulation                                                            |
| `sourceAccount`     | string (`G...`)                                    | none: the all-zero account `GAAA…AWHF` is used            | source of simulated transactions. If set, it must exist on the network (it is loaded with `getAccount`)                                  |
| `contractId`        | string (`C...`)                                    | none                                                      | contract to call when the target is a local `.wasm`/`.json` file (same as `--contract-id`)                                               |
| `timeoutMs`         | integer ≥ 1                                        | `30000`                                                   | per-request RPC timeout in milliseconds                                                                                                  |
| `retries`           | integer ≥ 0                                        | `2`                                                       | retries for transport failures (connection errors, timeouts, HTTP 429/5xx, JSON-RPC errors), with exponential backoff starting at 250 ms |

Network presets:

| preset      | RPC URL                                          | passphrase                                       |
| ----------- | ------------------------------------------------ | ------------------------------------------------ |
| `testnet`   | `https://soroban-testnet.stellar.org`            | `Test SDF Network ; September 2015`              |
| `futurenet` | `https://rpc-futurenet.stellar.org`              | `Test SDF Future Network ; October 2022`         |
| `mainnet`   | none (bring your own RPC provider)               | `Public Global Stellar Network ; September 2015` |
| `local`     | `http://localhost:8000/rpc` (stellar/quickstart) | `Standalone Network ; February 2017`             |

### Generation

| option                           | type                     | default | description                                                                                                           |
| -------------------------------- | ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `runs`                           | integer ≥ 0              | `100`   | random cases per function and per check, run **after** the boundary cases (`--runs`)                                  |
| `seed`                           | integer 0 to 4294967295  | random  | seed for all generation (`--seed`); always printed                                                                    |
| `generators.maxCollectionLength` | integer ≥ 1              | `5`     | max length of generated `Vec` and `Map` values                                                                        |
| `generators.maxStringLength`     | integer ≥ 1              | `32`    | max length of generated `String` values (characters)                                                                  |
| `generators.maxBytesLength`      | integer ≥ 1              | `64`    | max length of generated `Bytes` values                                                                                |
| `generators.addresses`           | string[] (`G...`/`C...`) | `[]`    | extra addresses used as boundary values and mixed into random addresses (for example an admin account)                |
| `generators.maxDepth`            | integer ≥ 0              | `4`     | nesting depth after which recursive user types are forced to their smallest case (void union case, empty vec, `None`) |
| `generators.maxBoundaryCases`    | integer ≥ 1              | `200`   | cap on boundary cases per function                                                                                    |

See [generators.md](generators.md) for what each type produces.

### Checks

| option                      | type                         | default                          | description                                                                                                                        |
| --------------------------- | ---------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `checks`                    | object: check name → boolean | all `true`                       | global on/off switch per check: `no-unexpected-trap`, `deterministic`, `read-only`, `budget`, `cost-regression`, `custom-property` |
| `budget.cpuInstructions`    | integer ≥ 1                  | none                             | max CPU instructions per call, for every function (`budget` check)                                                                 |
| `budget.memoryBytes`        | integer ≥ 1                  | none                             | max memory bytes per call. Only enforced when the RPC reports memory (stellar-rpc 30 does not)                                     |
| `baseline.path`             | string                       | `.soroban-testkit/baseline.json` | baseline file for `cost-regression` and `costs`                                                                                    |
| `baseline.thresholdPercent` | number ≥ 0                   | `10`                             | allowed growth of a function's max CPU/memory before `cost-regression` fails (`--threshold`)                                       |
| `properties`                | string[]                     | `[]`                             | files exporting [custom properties](custom-properties.md) (`.ts`, `.mjs`, `.js`)                                                   |
| `replayDir`                 | string                       | `.soroban-testkit/replays`       | where replay files are written                                                                                                     |

A check only runs where it has something to check: `read-only` only for functions with `readOnly: true`, `budget` only where a threshold is set, `cost-regression` only when the baseline file exists, and `custom-property` only for functions that a property targets.

### Per-function overrides

`functions` is an object keyed by function name:

| option                      | type                                 | default          | description                                                                   |
| --------------------------- | ------------------------------------ | ---------------- | ----------------------------------------------------------------------------- |
| `functions.<name>.skip`     | boolean                              | `false`          | do not test this function at all                                              |
| `functions.<name>.checks`   | object: check name → boolean         | inherit `checks` | enable or disable checks for this function only (overrides the global switch) |
| `functions.<name>.readOnly` | boolean                              | `false`          | the function must not write ledger state; enables `read-only` for it          |
| `functions.<name>.budget`   | `{ cpuInstructions?, memoryBytes? }` | inherit `budget` | thresholds for this function (each field overrides the global one)            |

```json
{
  "checks": { "deterministic": false },
  "functions": {
    "get_price": { "readOnly": true, "checks": { "deterministic": true } },
    "rebalance": { "budget": { "cpuInstructions": 50000000 } },
    "__check_auth": { "skip": true }
  }
}
```

A function named in `functions` that is not in the contract spec produces a note in the report (it is probably a typo). Constructors (`__constructor`) are always skipped: they only run at deploy time.

## Environment variables

| variable                     | overrides                | example                                             |
| ---------------------------- | ------------------------ | --------------------------------------------------- |
| `STELLAR_RPC_URL`            | `rpcUrl`                 | `https://soroban-testnet.stellar.org`               |
| `STELLAR_NETWORK_PASSPHRASE` | `networkPassphrase`      | `Test SDF Network ; September 2015`                 |
| `STELLAR_SOURCE_ACCOUNT`     | `sourceAccount`          | `GB...` (public key only; no secret is ever needed) |
| `NO_COLOR`                   | disables terminal colors | `1`                                                 |

Empty variables are ignored. CLI flags (`--rpc-url`, `--network-passphrase`, `--source-account`) override them.
