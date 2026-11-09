# Library API

Everything the CLI does is available as typed functions. Install the package and import from `soroban-testkit` (ESM only, Node 20+). Every exported symbol has TSDoc in the sources, so editors show the details. This page is the map.

```ts
import { loadConfig, fuzz, costs, renderTerminal, ExitCode } from 'soroban-testkit';

const config = await loadConfig({ overrides: { network: 'testnet', runs: 50, seed: 7 } });
const report = await fuzz({ target: 'CB...', config });
process.stdout.write(renderTerminal(report));
process.exitCode = report.findings.length > 0 ? ExitCode.Findings : ExitCode.Clean;
```

## High-level operations (what the CLI calls)

| export                                          | description                                                                                                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect(target, config)`                       | load a `ContractSpec` from a `.wasm`/`.json` path or a contract ID                                                                                                                     |
| `fuzz(options: FuzzOptions)`                    | run all enabled checks (or one replay with `replayFile`), returns a `RunReport`. Loads property files from `config.properties` and `propertyFiles`, and accepts in-memory `properties` |
| `costs(options: CostsOptions)`                  | measure costs; `mode`: `'measure'`, `'update-baseline'` (writes the file) or `'check-baseline'` (findings on regression). Returns `{ report, baselinePath, written? }`                 |
| `resolveRunTarget(target, config, contractId?)` | ping the RPC, check the passphrase, load the spec, and make sure the contract exists; returns `{ spec, contractId, client, notes }`                                                    |
| `clientFromConfig(config)`                      | create a `SimulationClient` (throws `UsageError` if no RPC URL is configured)                                                                                                          |
| `chooseSeed(...candidates)`                     | first defined candidate, or a random 32-bit seed                                                                                                                                       |
| `runCli(argv, io?)`                             | the whole CLI as a function returning the exit code; `io` can redirect stdout/stderr, env and cwd                                                                                      |

## Lower-level building blocks

### Running

| export                                          | description                                                                                                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run(options: RunOptions)`                      | the engine: per-function measurement, checks as fast-check properties, shrinking, replay files, baseline comparison. Takes any `Simulator` (an object with `simulate(contractId, fn, args, declared)`), so you can plug in your own transport |
| `replay(options: ReplayOptions)`                | re-run one `ReplayFile`                                                                                                                                                                                                                       |
| `readReplay(path)` / `writeReplay(dir, replay)` | replay file I/O                                                                                                                                                                                                                               |

#### RunReport

`run`, `fuzz` and `costs` return a `RunReport` (this is also the `--json` output):

```ts
interface RunReport {
  tool: { name: 'soroban-testkit'; version: string };
  mode: 'fuzz' | 'costs' | 'replay';
  contractId: string;
  seed: number;
  runs: number;
  startedAt: string; // ISO timestamp
  durationMs: number;
  findings: Finding[]; // check, function, property?, message, counterexample, shrunk, shrinkSteps, seed, details?, replayFile?
  functions: FunctionSummary[]; // name, checks, inputs, outcomes {success, contractError, trap, simulationFailed}, costs, skipped?
  simulations: number;
  simulationFailures: Array<{ function: string; input: string; message: string }>;
  baseline?: { path: string; seed: number; runs: number; comparison: BaselineComparison };
  notes: string[];
}
```

`Counterexample` holds `args` (JSON-safe, keyed by parameter name), `display` (`name=value, ...`) and `argsXdr` (base64 `ScVal` per argument).

### Spec

| export                                                                               | description                                                                 |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `loadSpecFromWasm(bytes)`                                                            | parse the `contractspecv0` section                                          |
| `loadSpecFromJson(text)`                                                             | parse a JSON spec (three formats; see [cli.md](cli.md))                     |
| `loadSpecFromFile(path)`                                                             | `.wasm` or JSON, detected by content                                        |
| `resolveTarget(target)`                                                              | `{ kind: 'file', path }` or `{ kind: 'contract', contractId }`              |
| `isWasm(bytes)`                                                                      | checks the `\0asm` header                                                   |
| `specFromXdrEntries(entries)`, `specFromJsonEntries(json)`, `specToXdrEntries(spec)` | convert between XDR `ScSpecEntry` values and the plain `ContractSpec` model |
| `formatType(typeRef)`                                                                | Rust-like rendering, e.g. `Vec<Option<u32>>`                                |
| `declaredErrorCodes(spec)`                                                           | map of code → `Enum::Case`                                                  |
| `PRIMITIVE_KINDS`                                                                    | all parameterless spec type kinds                                           |
| `renderSpec(spec, source)`                                                           | the `inspect` text output                                                   |

Types: `ContractSpec`, `FunctionSpec`, `NamedType`, `TypeRef`, `PrimitiveKind`, `UdtSpec`, `StructSpec`, `UnionSpec`, `UnionCase`, `EnumSpec`, `ErrorEnumSpec`, `EnumCase`, `Target`.

### Generation and encoding

| export                                                                               | description                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `arbitraryFor(type, spec, options?)`                                                 | fast-check arbitrary for one type                      |
| `argumentsArbitrary(fn, spec, options?)`                                             | arbitrary for a full argument list                     |
| `boundaryValues(type, spec, options?)`                                               | ordered boundary values for one type                   |
| `boundaryCases(fn, spec, options?)`                                                  | boundary argument lists for a function                 |
| `combineBoundaries(lists, cap)`                                                      | the combination strategy (first, one-varied, diagonal) |
| `DEFAULT_GENERATOR_OPTIONS`, `INT_RANGES`, `BOUNDARY_ADDRESSES`, `MAX_SYMBOL_LENGTH` | constants                                              |
| `toScVal(type, value, spec)` / `fromScVal(type, scval, spec)`                        | typed native ↔ `ScVal` conversion                      |
| `argsToScVals(types, args, spec)`                                                    | encode an argument list                                |
| `compareScVal(a, b)` / `sortedMap(entries)`                                          | host-compatible key ordering for maps                  |
| `formatValue(v)`, `formatArgs(names, args)`                                          | human-readable rendering                               |
| `toJsonSafe(v)` / `fromJsonSafe(json)`                                               | JSON round-trip of bigints and bytes                   |

Types: `GeneratorOptions`, `TaggedVal`, `UnionValue`, `JsonSafe`.

### RPC

| export                                                   | description                                                                                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SimulationClient`                                       | `ping()`, `simulate(contractId, fn, args, declared)`, `fetchSpec(contractId)`, `fetchWasm(contractId)`, `buildInvocation(...)`; retries transport errors and throws `RpcUnavailableError` |
| `NULL_ACCOUNT`                                           | the default source account                                                                                                                                                                |
| `classifyError(message, declared)`                       | host error string → `Outcome`                                                                                                                                                             |
| `parseSimulation(raw, declared)` / `parseResources(raw)` | raw JSON-RPC result → `SimulationResult` / `Resources`                                                                                                                                    |

Types: `RpcOptions`, `Outcome`, `Resources`, `SimulationResult`, `RawSimulation`.

### Checks and properties

| export                                           | description                                  |
| ------------------------------------------------ | -------------------------------------------- |
| `caseChecksFor(fn, config, properties)`          | the per-call checks that apply to a function |
| `noUnexpectedTrap`, `deterministic`, `readOnly`  | built-in `CaseCheck` objects                 |
| `budgetCheck(limits)`, `propertyCheck(property)` | check factories                              |
| `defineProperties(list)`                         | identity helper for property files           |
| `loadProperties(files)`                          | import and validate property files           |

Types: `CaseCheck`, `CaseCheckContext`, `Invocation`, `Violation`, `Property`, `PropertyContext`, `PropertyVerdict`, `CallResult`.

### Baseline

| export                                              | description                                          |
| --------------------------------------------------- | ---------------------------------------------------- |
| `computeCosts(samples)`                             | min/max/mean statistics                              |
| `compareCosts(baseline, current, thresholdPercent)` | regressions, improvements, new and missing functions |
| `readBaseline(path)` / `writeBaseline(path, file)`  | baseline file I/O                                    |

Types: `BaselineFile`, `BaselineComparison`, `CostDelta`, `CostMetric`, `FunctionCosts`, `MetricStats`.

### Reports

`renderTerminal(report, { target?, color? })`, `renderJson(report)`, `renderMarkdown(report, { target? })` and `renderJunit(report, { target? })` return strings. Type: `ReportOptions`.

### Configuration

| export                                                                  | description                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `defineConfig(config)`                                                  | identity helper for `soroban-testkit.config.ts`           |
| `loadConfig({ configPath?, cwd?, env?, overrides? })`                   | what the CLI does: find the file, merge env and overrides |
| `loadConfigFile(path)`                                                  | read and validate one file                                |
| `validateConfig(raw)`                                                   | validate an untrusted object (throws `ConfigError`)       |
| `resolveConfig(file, configFile, env, overrides?, cwd?)`                | merge into a `ResolvedConfig`                             |
| `checkEnabled(config, fn, check)`, `budgetFor(config, fn)`              | per-function resolution                                   |
| `CHECK_NAMES`, `CONFIG_KEYS`, `ENV_VARS`, `NETWORK_PRESETS`, `DEFAULTS` | constants                                                 |

Types: `CheckName`, `UserConfig`, `ResolvedConfig`, `FunctionConfig`, `BudgetThresholds`, `BaselineConfig`, `NetworkPreset`, `ConfigOverrides`.

### Errors

`TestkitError` (base, with `exitCode`), `UsageError` and `ConfigError` and `SpecError` (exit `2`), `RpcUnavailableError` (exit `3`). `ExitCode` holds the numeric codes (`Clean`, `Findings`, `Usage`, `RpcUnavailable`); type `ExitCodeValue`. `VERSION` is the package version.
