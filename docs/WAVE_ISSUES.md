# Wave issues

This file holds ready-to-paste GitHub issues for the Stellar Wave (Drips Wave) program. Each one describes a gap that exists in the code today, with acceptance criteria and the files to start from. Copy the text under a heading into a new issue and add the labels listed. Complexity levels:

- **Trivial**: under about 2 hours. Documentation or a small, local code change.
- **Medium**: a focused feature in one or two modules, with tests and docs.
- **High**: design work across several modules. Expect to discuss the approach in the issue before writing much code.

Every issue requires `make verify` to pass (lint, typecheck, unit tests with coverage, e2e, build, docs-check). If you add a CLI flag, command, config key, check or export, `make docs-check` will fail until the matching page under `docs/` mentions it; that is intended.

## Summary

| #   | Title                                                             | Complexity |
| --- | ----------------------------------------------------------------- | ---------- |
| 1   | Add a `--print-config` flag that shows the resolved configuration | Trivial    |
| 2   | Add a --quiet flag that suppresses progress output                | Trivial    |
| 3   | Honor FORCE_COLOR and read NO_COLOR from the injected environment | Trivial    |
| 4   | Add a list-checks command                                         | Trivial    |
| 5   | Report a note when a memory budget cannot be evaluated            | Trivial    |
| 6   | Show parameter, field and enum case docs in inspect output        | Trivial    |
| 7   | Show the largest write footprint in the cost tables               | Trivial    |
| 8   | Add a VS Code tasks template                                      | Trivial    |
| 9   | SARIF reporter for GitHub code scanning                           | Medium     |
| 10  | Self-contained HTML report                                        | Medium     |
| 11  | GitHub Action wrapper (action.yml)                                | Medium     |
| 12  | Authorization-required check using simulation auth entries        | Medium     |
| 13  | Event-emission check using simulation events                      | Medium     |
| 14  | Detect archived state (restorePreamble) in simulation results     | Medium     |
| 15  | JSON Schema for the config file                                   | Medium     |
| 16  | init command that scaffolds soroban-testkit.config.ts             | Medium     |
| 17  | Known-findings allow-list and --fail-on                           | Medium     |
| 18  | Generate muxed (M...) addresses for muxed_address parameters      | Medium     |
| 19  | Compare full function signatures when the local spec differs      | Medium     |
| 20  | Match the host's map key ordering exactly for complex keys        | Medium     |
| 21  | Cost history and Markdown/SVG cost charts                         | Medium     |
| 22  | More example contracts: token interface and rich types            | Medium     |
| 23  | Per-parameter value generators and hints in config                | High       |
| 24  | Parallel simulations with deterministic reports                   | High       |
| 25  | Deploy a local .wasm to a local network before fuzzing            | High       |
| 26  | Stateful multi-call sequence testing on a local network           | High       |
| 27  | Fuzz constructor arguments by deploying per case                  | High       |

---

### 1. Add a `--print-config` flag that shows the resolved configuration

**Complexity:** Trivial

**Labels:** `wave`, `good first issue`, `cli`

**Description**

Configuration is merged from CLI flags, environment variables, a config file, a network preset and defaults (`resolveConfig` in `src/config/config.ts`). When a run behaves unexpectedly (wrong RPC URL, wrong passphrase, a check not running), there is no way to see the final merged values. A `--print-config` flag on `fuzz` and `costs` that prints the `ResolvedConfig` as JSON and exits `0` would make this easy to debug.

**Acceptance criteria**

- [ ] `soroban-testkit fuzz <target> --print-config` and `costs ... --print-config` print the resolved config as JSON and exit `0` without contacting the RPC.
- [ ] The output shows which config file was loaded (`configFile`).
- [ ] A test in `test/unit/cli.test.ts` covers precedence (flag over env over file) through `--print-config`.
- [ ] `docs/cli.md` documents the flag (`make docs-check` enforces this) and `docs/troubleshooting.md` mentions it.
- [ ] CHANGELOG.md has an entry under Unreleased.
- [ ] `make verify` passes.

**Files to look at**

- `src/cli/program.ts` (`addRunOptions`, the `fuzz` and `costs` actions)
- `src/config/config.ts` (`loadConfig`, `resolveConfig`, `ResolvedConfig`)
- `test/unit/cli.test.ts`
- `docs/cli.md`, `docs/troubleshooting.md`

---

### 2. Add a --quiet flag that suppresses progress output

**Complexity:** Trivial

**Labels:** `wave`, `good first issue`, `cli`

**Description**

`fuzz` and `costs` always write progress lines to stderr: the "fuzzing ... with seed ..." / "measuring costs of ..." header and one line per function from `progress()` in `src/cli/program.ts`. In CI logs and scripts that capture stderr this is noise. A `--quiet` flag should suppress these lines while keeping errors and the final report.

**Acceptance criteria**

- [ ] `fuzz` and `costs` accept `-q, --quiet`.
- [ ] With `--quiet`, the header line, the per-function progress lines and the "baseline written to ..." line are not printed. Errors (`soroban-testkit: error: ...`) and the report on stdout are unchanged.
- [ ] Tests in `test/unit/cli.test.ts` cover both modes by capturing `stderr` through `CliIO`.
- [ ] `docs/cli.md` documents the flag (`make docs-check` checks this).
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/cli/program.ts` (`addRunOptions`, `progress`, the `fuzz` and `costs` actions)
- `test/unit/cli.test.ts`
- `docs/cli.md`

---

### 3. Honor FORCE_COLOR and read NO_COLOR from the injected environment

**Complexity:** Trivial

**Labels:** `wave`, `good first issue`, `cli`

**Description**

`runCli` in `src/cli/program.ts` decides color with `Boolean(process.stdout.isTTY) && !process.env.NO_COLOR`. Two gaps: it reads `process.env` instead of the `env` passed in through `CliIO`, so the behaviour cannot be tested through `runCli`; and `FORCE_COLOR` is ignored, so colors cannot be turned on in CI systems that render ANSI codes but are not a TTY (for example GitHub Actions logs).

**Acceptance criteria**

- [ ] Color is decided from `io.env`: `NO_COLOR` (any non-empty value) disables color; `FORCE_COLOR` set to a value other than `0` enables it even without a TTY; `FORCE_COLOR=0` disables it. `--no-color` still wins over everything.
- [ ] Unit tests in `test/unit/cli.test.ts` cover each case by passing `env` to `runCli` and checking for ANSI escape codes in the output.
- [ ] `docs/cli.md` documents `NO_COLOR` and `FORCE_COLOR` and the precedence.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/cli/program.ts` (`runCli`, `CliIO`)
- `src/report/reporters.ts` (`renderTerminal`, `palette`)
- `test/unit/cli.test.ts`
- `docs/cli.md`

---

### 4. Add a list-checks command

**Complexity:** Trivial

**Labels:** `wave`, `good first issue`, `cli`, `checks`

**Description**

Users have to read the docs to learn the check names they can use under `checks` and `functions.<name>.checks` in the config. The names live in `CHECK_NAMES` in `src/config/config.ts`. A `soroban-testkit list-checks` command should print each check with a one-line description, whether it runs per invocation or per function (`cost-regression`), and what it needs to run (`read-only` needs `functions.<name>.readOnly`, `budget` needs thresholds, `cost-regression` needs a baseline, `custom-property` needs property files).

**Acceptance criteria**

- [ ] `soroban-testkit list-checks` prints every entry of `CHECK_NAMES`; a test fails if a check is added to `CHECK_NAMES` without a description.
- [ ] `--json` prints the same information as JSON.
- [ ] Exit code 0, no RPC access.
- [ ] Tests in `test/unit/cli.test.ts`.
- [ ] `docs/cli.md` has a `soroban-testkit list-checks` heading (`make docs-check` requires one per command).
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/cli/program.ts` (`buildProgram`)
- `src/config/config.ts` (`CHECK_NAMES`)
- `src/checks/checks.ts` (`caseChecksFor` shows the preconditions)
- `docs/cli.md`, `docs/checks.md`

---

### 5. Report a note when a memory budget cannot be evaluated

**Complexity:** Trivial

**Labels:** `wave`, `good first issue`, `checks`

**Description**

stellar-rpc 30 no longer returns the `cost` field in `simulateTransaction` responses, so `parseResources` in `src/rpc/outcome.ts` sets `memoryBytes` to `null`. `budgetCheck` in `src/checks/checks.ts` then skips the memory comparison silently. A user who configures `budget.memoryBytes` sees every function pass and has no way to know the limit was never applied. The same applies to the memory side of `cost-regression`.

**Acceptance criteria**

- [ ] When a function has a `memoryBytes` budget (global or per function, see `budgetFor`) and none of its successful simulations reported memory, the run adds one note to `RunReport.notes` saying the memory budget could not be checked because the RPC does not report memory.
- [ ] The note appears once per run (or once per function), not once per simulation.
- [ ] A unit test in `test/unit/checks.test.ts` or `test/unit/runner.test.ts` uses the fake RPC with `reportCost: false` (the default) and asserts the note; with `reportCost: true` the note is absent.
- [ ] `docs/checks.md` (the `budget` section) explains the limitation.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/checks/checks.ts` (`budgetCheck`, `caseChecksFor`)
- `src/runner/runner.ts` (`run`, `report.notes`)
- `src/rpc/outcome.ts` (`parseResources`)
- `src/config/config.ts` (`budgetFor`)
- `test/fake-rpc/server.ts` (`reportCost` option)

---

### 6. Show parameter, field and enum case docs in inspect output

**Complexity:** Trivial

**Labels:** `wave`, `good first issue`, `cli`

**Description**

`renderSpec` in `src/report/inspect.ts` prints the doc comment of each function and each user-defined type, but not the docs of individual parameters and struct fields (`NamedType.doc`), union cases (`UnionCase.doc`) or enum and error cases (`EnumCase.doc`). Those docs are already parsed into the `ContractSpec`; they are just not rendered. Error case docs in particular help users decide which errors are expected.

**Acceptance criteria**

- [ ] Non-empty parameter, field and case docs are printed, indented under their owner. Empty docs add no lines, so output for contracts without docs is unchanged.
- [ ] A unit test renders a spec with docs at every level (fixtures in `test/fixtures/specs.ts`) and checks the output.
- [ ] Saved demo output under `docs/demo-output/` is regenerated with `make demo` if it changes.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/report/inspect.ts` (`renderSpec`, `renderUdt`, `docLine`)
- `src/spec/types.ts` (`NamedType`, `UnionCase`, `EnumCase`)
- `test/fixtures/specs.ts`
- `test/unit/report.test.ts`

---

### 7. Show the largest write footprint in the cost tables

**Complexity:** Trivial

**Labels:** `wave`, `good first issue`, `reporter`

**Description**

`computeCosts` in `src/baseline/baseline.ts` records `maxWriteEntries` for every function, and it is stored in the baseline file, but neither the terminal COSTS table (`costRows` in `src/report/reporters.ts`) nor the Markdown function table shows it. The number of ledger entries written is a large part of the fee and is useful when reviewing a cost change.

**Acceptance criteria**

- [ ] The terminal COSTS table and the Markdown table gain a "writes max" column using `FunctionCosts.maxWriteEntries` (`-` when there are no costs).
- [ ] Report snapshots in `test/unit/__snapshots__/` are updated and reviewed.
- [ ] Saved demo output under `docs/demo-output/` is regenerated with `make demo`.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/report/reporters.ts` (`costRows`, `renderMarkdown`)
- `src/baseline/baseline.ts` (`FunctionCosts`, `computeCosts`)
- `test/unit/report.test.ts`, `test/unit/__snapshots__/`

---

### 8. Add a VS Code tasks template

**Complexity:** Trivial

**Labels:** `wave`, `good first issue`, `docs`

**Description**

Many Soroban developers work in VS Code. A ready-made `tasks.json` with tasks for `inspect`, `fuzz`, `costs --check-baseline` and replaying a finding (using a `${input:...}` prompt for the replay file) lowers the cost of running the tool during development.

**Acceptance criteria**

- [ ] `examples/vscode/tasks.json` with at least four tasks: inspect the current `.wasm`, fuzz with `--contract-id` from an input prompt, check the cost baseline, replay a chosen file from `.soroban-testkit/replays/`.
- [ ] Tasks call `npx soroban-testkit` and use only flags that exist (see `buildProgram` in `src/cli/program.ts`).
- [ ] A short section in the docs explains how to copy the file into `.vscode/`.
- [ ] A test in `test/unit/examples.test.ts` parses the file (JSONC comments allowed) and checks that every `--flag` used is a real option of the command.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/cli/program.ts`
- `test/unit/examples.test.ts`
- `examples/vault-demo/soroban-testkit.config.json`

---

### 9. SARIF reporter for GitHub code scanning

**Complexity:** Medium

**Labels:** `wave`, `enhancement`, `reporter`

**Description**

Reports exist for the terminal, JSON, Markdown and JUnit XML (`src/report/reporters.ts`). GitHub code scanning, and several other tools, consume SARIF 2.1.0. A SARIF reporter would show findings in the Security tab and on pull requests without custom scripts.

**Acceptance criteria**

- [ ] `renderSarif(report, opts)` in `src/report/reporters.ts` produces valid SARIF 2.1.0: one `rule` per check name in `CHECK_NAMES`, one `result` per `Finding` with the message, counterexample, seed and replay command.
- [ ] Results use a logical location for the contract function; when the target is a local file, the artifact location points at it.
- [ ] `fuzz` and `costs` accept `--sarif [file]`, following the same stdout rules as the other formats in `emitReports`.
- [ ] `renderSarif` is exported from `src/index.ts` with TSDoc and listed in `docs/api.md`.
- [ ] Snapshot tests for a clean and a buggy report, plus a test that validates the output against the SARIF 2.1.0 JSON schema (vendored as a test fixture, no network access in tests).
- [ ] `docs/cli.md` documents the flag; a docs example shows uploading with `github/codeql-action/upload-sarif`.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/report/reporters.ts` (`renderJunit` is the closest model)
- `src/cli/program.ts` (`addRunOptions`, `emitReports`)
- `src/runner/runner.ts` (`Finding`, `RunReport`)
- `src/index.ts`
- `test/unit/report.test.ts`, `test/unit/__snapshots__/`

---

### 10. Self-contained HTML report

**Complexity:** Medium

**Labels:** `wave`, `enhancement`, `reporter`

**Description**

The Markdown report works for PR comments, but a single HTML file is easier to attach as a CI artifact and to read locally: collapsible findings, the cost table, baseline deltas, notes and simulation failures. Everything needed is already in `RunReport`.

**Acceptance criteria**

- [ ] `renderHtml(report, opts)` in `src/report/reporters.ts` returns one HTML document with inline CSS and no external requests (no CDN scripts or fonts).
- [ ] All values that come from the contract or the RPC (messages, counterexamples, host details, notes) are HTML-escaped; a test feeds `<script>` through a finding message and checks it is escaped.
- [ ] `fuzz` and `costs` accept `--html [file]`, following the stdout rules in `emitReports`.
- [ ] Exported from `src/index.ts` with TSDoc and listed in `docs/api.md`.
- [ ] Snapshot tests for a clean and a buggy report.
- [ ] `docs/cli.md` documents the flag.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/report/reporters.ts` (`renderMarkdown`, `xml` escaping helper)
- `src/cli/program.ts` (`emitReports`)
- `src/index.ts`
- `test/unit/report.test.ts`

---

### 11. GitHub Action wrapper (action.yml)

**Complexity:** Medium

**Labels:** `wave`, `enhancement`, `ci`

**Description**

Using the tool in GitHub Actions today means writing the install and invocation steps by hand. A composite action at the repository root would let users write `uses: <owner>/soroban-testkit@v0` with inputs for the target, command, contract ID, network, seed, runs and baseline mode, and get the Markdown report in the job summary.

**Acceptance criteria**

- [ ] `action.yml` (composite) with inputs: `command` (`fuzz` or `costs`), `target`, `contract-id`, `network`, `rpc-url`, `seed`, `runs`, `baseline-mode` (`check` / `update` / none), `config`, `version`.
- [ ] The action installs the requested version, runs the command, writes `--markdown` to `$GITHUB_STEP_SUMMARY`, writes `--junit` to a file exposed as an output, and returns the tool's exit code (1 = findings, 2 = usage, 3 = RPC unavailable).
- [ ] Inputs are passed through environment variables, not interpolated into shell lines, to avoid script injection.
- [ ] A workflow under `.github/workflows/` runs the action against the bundled fake RPC (`scripts/demo-rpc.ts`) and asserts exit codes for the clean and buggy example contracts.
- [ ] A docs page with a complete example workflow, including `costs --check-baseline` on pull requests.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/cli/program.ts` (flags and exit codes)
- `src/errors.ts` (`ExitCode`)
- `scripts/demo-rpc.ts`
- `scripts/demo.ts`

---

### 12. Authorization-required check using simulation auth entries

**Complexity:** Medium

**Labels:** `wave`, `enhancement`, `checks`

**Description**

A common Soroban bug is a state-changing function that forgets `require_auth`. Simulation in recording mode returns the authorization entries a call needs in `results[].auth`. `RawSimulation` in `src/rpc/outcome.ts` declares that field, but `parseSimulation` ignores it. A new check could flag functions that are configured as requiring authorization but succeed with no auth entries, and could report which addresses were asked to authorize.

**Acceptance criteria**

- [ ] `SimulationResult` gains the decoded auth entries (at least: the address that must authorize and the invoked contract function) for successful simulations.
- [ ] New check `requires-auth` added to `CHECK_NAMES`, enabled for a function by a new config key (for example `functions.<name>.requiresAuth: true`, optionally a list of parameter names whose address must authorize). It fails when a successful call has no matching auth entry.
- [ ] Shrinking and replay work like the other per-invocation checks (`caseChecksFor`, `replay` in `src/runner/runner.ts`).
- [ ] The fake RPC can return auth entries for a handler so the check is covered by unit tests, including a planted bug.
- [ ] `CONFIG_KEYS`, `docs/configuration.md`, `docs/checks.md` and `docs/concepts.md` updated (`make docs-check` enforces these).
- [ ] Custom properties can read the auth entries through `PropertyContext`.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/rpc/outcome.ts` (`RawSimulation`, `parseSimulation`)
- `src/checks/checks.ts` (`caseChecksFor`, `readOnly` is a similar config-gated check)
- `src/checks/properties.ts` (`PropertyContext`)
- `src/config/config.ts` (`CHECK_NAMES`, `CONFIG_KEYS`, `validateConfig`)
- `test/fake-rpc/server.ts`, `test/fake-rpc/contracts.ts`

---

### 13. Event-emission check using simulation events

**Complexity:** Medium

**Labels:** `wave`, `enhancement`, `checks`

**Description**

`simulateTransaction` returns the diagnostic and contract events emitted during the call (`events`, base64 XDR). The tool ignores them: `RawSimulation` does not declare the field. Contracts often promise to emit an event on every successful state change (for example `transfer` on a token). A check that verifies configured events are emitted on success, and that the event topics match the spec's declared events (`ContractSpec.events`), would catch silent changes in event behaviour.

**Acceptance criteria**

- [ ] `parseSimulation` decodes contract events (type, contract ID, topics, data) into `SimulationResult`; diagnostic-only events are kept separate or dropped.
- [ ] New check `emits-events` in `CHECK_NAMES`, configured per function (for example `functions.<name>.emits: ["transfer"]`), failing when a successful call does not emit an event whose first topic matches.
- [ ] Events are available to custom properties through `PropertyContext`, so users can assert on topics and data.
- [ ] The fake RPC can return events from a handler; unit tests cover pass, fail and replay.
- [ ] `CONFIG_KEYS`, `docs/configuration.md`, `docs/checks.md`, `docs/concepts.md` updated.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/rpc/outcome.ts` (`RawSimulation`, `parseSimulation`)
- `src/spec/types.ts` (`ContractSpec.events`)
- `src/checks/checks.ts`, `src/checks/properties.ts`
- `src/config/config.ts`
- `test/fake-rpc/server.ts` (currently always returns `events: []`)

---

### 14. Detect archived state (restorePreamble) in simulation results

**Complexity:** Medium

**Labels:** `wave`, `enhancement`, `rpc`

**Description**

When a call touches archived (expired TTL) ledger entries, `simulateTransaction` returns a `restorePreamble` describing the entries that must be restored first. `RawSimulation` declares the field but nothing reads it, so such a simulation is counted as a normal success and its costs go into the baseline. Results against a contract with archived state can therefore be misleading, and the user is not told.

**Acceptance criteria**

- [ ] `parseSimulation` records whether a restore is needed (and the number of entries / minimum restore fee) on `SimulationResult`.
- [ ] The runner counts these simulations per function and adds a note to `RunReport.notes` explaining that state is archived and how to restore it (for example `stellar contract restore`).
- [ ] Simulations that need a restore are excluded from cost statistics (`measure` in `src/runner/runner.ts`), or included but clearly marked; document which.
- [ ] Optionally a new check (for example `no-archived-state`) that fails instead of noting; if added, update `CHECK_NAMES` and the docs.
- [ ] The fake RPC can return a `restorePreamble`; unit tests cover the note and the cost exclusion.
- [ ] `docs/concepts.md` or `docs/checks.md` explains the behaviour.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/rpc/outcome.ts` (`RawSimulation.restorePreamble`, `parseSimulation`)
- `src/runner/runner.ts` (`measure`, `run`)
- `src/baseline/baseline.ts` (`computeCosts`)
- `test/fake-rpc/server.ts`

---

### 15. JSON Schema for the config file

**Complexity:** Medium

**Labels:** `wave`, `enhancement`, `config`

**Description**

`validateConfig` in `src/config/config.ts` already accepts a `$schema` key, but no schema is published, so JSON config files get no editor completion or validation. A JSON Schema generated from (or tested against) the validator would give that, and a test would keep the schema and the validator in sync.

**Acceptance criteria**

- [ ] A JSON Schema (draft 2020-12 or draft-07) file for `soroban-testkit.config.json` covering every key in `CONFIG_KEYS`, with descriptions taken from the TSDoc on `UserConfig`, and `additionalProperties: false` where `validateConfig` rejects unknown keys.
- [ ] The schema is included in the published package (`files` in `package.json`) so it can be referenced from `node_modules`.
- [ ] A unit test checks that every `CONFIG_KEYS` entry appears in the schema, and that a set of valid and invalid sample configs gets the same verdict from the schema and from `validateConfig`.
- [ ] The example configs under `examples/` reference the schema with `$schema`.
- [ ] `docs/configuration.md` explains how to use it.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/config/config.ts` (`UserConfig`, `CONFIG_KEYS`, `validateConfig`)
- `test/unit/config.test.ts`
- `examples/vault-demo/soroban-testkit.config.json`, `examples/custom-properties/soroban-testkit.config.json`
- `package.json`

---

### 16. init command that scaffolds soroban-testkit.config.ts

**Complexity:** Medium

**Labels:** `wave`, `enhancement`, `cli`

**Description**

New users start from an empty directory and have to read `docs/configuration.md` to write a config. `soroban-testkit init` could write a commented `soroban-testkit.config.ts` using `defineConfig`. When given a `.wasm` or spec file, it could pre-fill `functions` with an entry per contract function (with `readOnly` guessed for functions whose names look like getters, clearly marked as a guess to review) and a starter property file.

**Acceptance criteria**

- [ ] `soroban-testkit init [target]` writes `soroban-testkit.config.ts` (or `.json` with `--json`) in the working directory.
- [ ] Refuses to overwrite an existing config (any name in `CONFIG_FILE_NAMES`) unless `--force` is given.
- [ ] The generated file passes `loadConfigFile` / `validateConfig`; a test loads it back.
- [ ] With a target, every function from the spec appears under `functions`; `__constructor` is excluded.
- [ ] No network access unless the target is a contract ID.
- [ ] `docs/cli.md` has a `soroban-testkit init` heading and documents the flags.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/cli/program.ts` (`buildProgram`)
- `src/config/config.ts` (`defineConfig`, `CONFIG_FILE_NAMES`, `loadConfigFile`)
- `src/api.ts` (`inspect`)
- `test/unit/cli.test.ts`, `test/unit/config.test.ts`

---

### 17. Known-findings allow-list and --fail-on

**Complexity:** Medium

**Labels:** `wave`, `enhancement`, `cli`, `config`

**Description**

Every finding makes `fuzz` exit 1 (`state.code` in `src/cli/program.ts`). Teams adopting the tool on an existing contract often have known, accepted findings and want CI to fail only on new ones. Two related features: an allow-list of accepted findings (matched by check, function and property, with a required reason), and `--fail-on <checks>` to choose which checks affect the exit code.

**Acceptance criteria**

- [ ] A config key (for example `ignore: [{ check, function, property?, reason }]`) validated in `validateConfig` and listed in `CONFIG_KEYS`.
- [ ] Ignored findings still appear in every report format, marked as ignored with the reason, and do not affect the exit code.
- [ ] An ignore entry that matched nothing produces a note, so stale entries are noticed.
- [ ] `--fail-on <checks>` (comma-separated `CHECK_NAMES`) limits which findings cause exit 1; unknown names are a usage error (exit 2).
- [ ] Unit tests for matching, reporting and exit codes; report snapshots updated.
- [ ] `docs/configuration.md` and `docs/cli.md` updated.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/cli/program.ts` (exit code logic in the `fuzz` and `costs` actions)
- `src/config/config.ts`
- `src/runner/runner.ts` (`Finding`, `RunReport`)
- `src/report/reporters.ts`

---

### 18. Generate muxed (M...) addresses for muxed_address parameters

**Complexity:** Medium

**Labels:** `wave`, `enhancement`, `generators`

**Description**

For `muxed_address` parameters, `arbitraryFor` and `boundaryValues` in `src/generate/arbitraries.ts` produce the same values as for `address`: only `G...` and `C...` strkeys. Muxed accounts (`M...`, an account plus a 64-bit ID) are never generated, so code paths that handle the muxed ID are never exercised. `generators.addresses` validation in `validateConfig` also rejects `M...` strkeys.

**Acceptance criteria**

- [ ] `muxed_address` generation includes `M...` addresses (random ed25519 key plus random u64 ID, with boundary IDs 0 and 2^64-1), alongside `G...` and `C...`.
- [ ] `toScVal` / `fromScVal` in `src/generate/scval.ts` encode and decode muxed addresses as the host expects (`ScAddress` muxed account variant); round-trip tests cover them.
- [ ] Shrinking a muxed address yields valid strkeys.
- [ ] `generators.addresses` accepts `M...` strkeys; plain `address` parameters never receive an `M...` value.
- [ ] Replay files with muxed arguments decode correctly.
- [ ] `docs/` generator documentation and the value table at the top of `src/generate/arbitraries.ts` are updated.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/generate/arbitraries.ts` (`arbitraryFor`, `boundaryValues`, `accountArb`, `BOUNDARY_ADDRESSES`)
- `src/generate/scval.ts` (`toScVal`, `fromScVal`)
- `src/config/config.ts` (`validateConfig`, `generators.addresses`)
- `test/unit/generate.test.ts`

---

### 19. Compare full function signatures when the local spec differs

**Complexity:** Medium

**Labels:** `wave`, `enhancement`

**Description**

When the target is a local file and `--contract-id` points at a deployed contract, `resolveRunTarget` in `src/api.ts` warns only if the sorted function names differ. If a parameter type, parameter order, return type or a user-defined type changed, no warning is shown, and the tool encodes arguments with the local spec while the deployed contract expects something else. The typical result is a wall of `simulation-failed` or misleading traps.

**Acceptance criteria**

- [ ] The comparison covers, per function: parameter names, order and types (`formatType`), and return types; plus the user-defined types those reference.
- [ ] The note lists the specific differences (for example `transfer: amount i128 -> u64`), capped to a reasonable number of lines.
- [ ] A comparison helper is unit-tested on its own with fixtures from `test/fixtures/specs.ts`.
- [ ] Existing behaviour for identical specs (no note) is unchanged.
- [ ] Docs that describe the mismatch warning are updated.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/api.ts` (`resolveRunTarget`)
- `src/spec/types.ts` (`formatType`, `FunctionSpec`, `UdtSpec`)
- `test/fixtures/specs.ts`
- `test/unit/spec.test.ts`

---

### 20. Match the host's map key ordering exactly for complex keys

**Complexity:** Medium

**Labels:** `wave`, `bug`, `generators`

**Description**

The host rejects `ScMap` values whose keys are not sorted in its own order. `compareScVal` in `src/generate/scval.ts` (used by `sortedMap`) implements that order for numbers, bools, bytes, strings, symbols and vectors, and falls back to comparing XDR bytes for everything else (maps, addresses, nested structs, `Option`, errors). The fallback is an approximation: for map keys of those types the encoded order can differ from the host's `Ord` for `ScVal`, which causes `simulation-failed` results that hide real behaviour.

**Acceptance criteria**

- [ ] `compareScVal` follows the host's ordering for every `ScVal` type that can appear as a map key, with a comment citing the host implementation it mirrors.
- [ ] Unit tests in `test/unit/generate.test.ts` with known-order fixtures for maps keyed by addresses, vectors of mixed types, nested maps and structs.
- [ ] If possible, a case in `scripts/integration.ts` (`make integration`) that sends maps with complex keys to a real network and expects no host error.
- [ ] Remove "approximate" caveats from the docs once fixed.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/generate/scval.ts` (`compareScVal`, `sortedMap`, `SCV_ORDER`)
- `test/unit/generate.test.ts`
- `scripts/integration.ts`

---

### 21. Cost history and Markdown/SVG cost charts

**Complexity:** Medium

**Labels:** `wave`, `enhancement`, `reporter`

**Description**

The baseline file (`BaselineFile` in `src/baseline/baseline.ts`) holds one snapshot. When a regression is reported there is no view of how a function's cost moved over the previous changes. Keeping a history of snapshots and rendering a small chart per function would make gradual cost creep visible, including creep that never crosses the threshold in a single change.

**Acceptance criteria**

- [ ] `costs --update-baseline` can append the snapshot to a history file or directory (opt-in, for example `--history <path>` and a matching config key), with a cap on the number of entries kept.
- [ ] A renderer produces a Markdown table with a text sparkline per function (CPU max, memory max when available) and, optionally, a static SVG line chart per function with no external dependencies.
- [ ] The Markdown report includes the sparkline column when history is available.
- [ ] Unit tests for appending, capping and rendering; SVG output is snapshot-tested.
- [ ] `docs/cli.md` and `docs/configuration.md` updated.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/baseline/baseline.ts` (`BaselineFile`, `writeBaseline`, `compareCosts`)
- `src/api.ts` (`costs`)
- `src/report/reporters.ts` (`renderMarkdown`, `baselineLines`)
- `src/cli/program.ts`

---

### 22. More example contracts: token interface and rich types

**Complexity:** Medium

**Labels:** `wave`, `examples`, `docs`

**Description**

The only Rust example is the vault (`examples/rust-contracts/vault`), which mostly uses primitives. Two more examples would show the tool on realistic interfaces: a contract implementing the standard token interface (balances, allowances, `transfer`/`transfer_from`/`approve`, with token properties similar to `examples/custom-properties/token-balances.ts`), and a contract whose parameters use structs, unions, enums, `Option`, `Map` and nested `Vec`s.

**Acceptance criteria**

- [ ] Two new crates under `examples/rust-contracts/`, added to the workspace `Cargo.toml` and built by `examples/rust-contracts/build.sh` (`make examples-wasm`); compiled `.wasm` files committed under `examples/wasm/`.
- [ ] Each example has a config file and at least one property file; any planted bugs are marked `PLANTED BUG` like the vault.
- [ ] `test/unit/examples.test.ts` loads the new wasm specs and checks that generation and encoding succeed for every function (no RPC needed).
- [ ] If feasible, `scripts/integration.ts` deploys and fuzzes them in `make integration`.
- [ ] A docs section describes each example and the expected output.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `examples/rust-contracts/` (`Cargo.toml`, `build.sh`, `vault/src/lib.rs`)
- `examples/custom-properties/token-balances.ts`
- `test/unit/examples.test.ts`
- `scripts/integration.ts`

---

### 23. Per-parameter value generators and hints in config

**Complexity:** High

**Labels:** `wave`, `enhancement`, `generators`, `config`

**Description**

Generation is driven only by the spec type plus the global `generators` options (`GeneratorOptions` in `src/generate/arbitraries.ts`). An `i128 amount` is drawn from the full i128 range, so most inputs are rejected early by the contract (for example with `NegativeAmount` or `InsufficientBalance`) and the interesting middle of the input space is rarely reached. Users need a way to say, per function and parameter, "amount is between 0 and 10_000", "to is one of these addresses", or, in a TypeScript config, "use this fast-check arbitrary".

**Acceptance criteria**

- [ ] A design comment in the issue is agreed before implementation (config shape, how hints combine with boundary values, how nested struct fields are addressed).
- [ ] Config supports per-parameter hints, for example `functions.<name>.args.<param>` with `min`/`max` for integers, `values` (a fixed list), `addresses`, `maxLength`; validated in `validateConfig` and listed in `CONFIG_KEYS`.
- [ ] In TypeScript configs, a hint may be a fast-check `Arbitrary`.
- [ ] `argumentsArbitrary` and `boundaryCases` honour the hints; boundary values respect the range (min, max, min+1, ...) while values outside it are no longer generated.
- [ ] Shrinking stays within the hinted range, and replay files keep working.
- [ ] Hints for unknown parameters, or hints whose type does not match the parameter type, are config errors with a clear message.
- [ ] Unit tests for each hint kind and for interaction with `maxBoundaryCases`.
- [ ] `docs/configuration.md` and the generator docs updated with examples.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/generate/arbitraries.ts` (`arbitraryFor`, `argumentsArbitrary`, `boundaryValues`, `boundaryCases`, `GeneratorOptions`)
- `src/config/config.ts` (`FunctionConfig`, `validateConfig`, `CONFIG_KEYS`)
- `src/runner/runner.ts` (`measure`, `Engine.runCaseCheck`)
- `test/unit/generate.test.ts`, `test/unit/config.test.ts`

---

### 24. Parallel simulations with deterministic reports

**Complexity:** High

**Labels:** `wave`, `enhancement`, `performance`

**Description**

The runner is fully sequential: `run` in `src/runner/runner.ts` processes functions one at a time, `measure` awaits each simulation in turn, and each check runs as its own `fc.check`. With remote RPCs, wall time is dominated by request latency. Running several simulations at once could cut run time a lot, but the report (findings, counterexamples, shrink steps, simulation counts, replay files) must stay identical for a given seed regardless of concurrency.

**Acceptance criteria**

- [ ] A design comment in the issue is agreed first. One option: pre-generate inputs (boundary cases plus `fc.sample` with the run seed) and warm the `Engine` cache with bounded concurrency, leaving `fc.check` and shrinking sequential.
- [ ] `--concurrency <n>` flag and `concurrency` config key (default chosen conservatively, for example 4; `1` reproduces today's behaviour).
- [ ] A test runs the same seed with concurrency 1 and 8 against the fake RPC and asserts equal findings, counterexamples and function summaries.
- [ ] Transport retries and rate limiting (HTTP 429 handling in `SimulationClient.transport`) still work under load; a test uses the fake RPC's failure injection.
- [ ] `RpcUnavailableError` still aborts the whole run promptly.
- [ ] `docs/cli.md` and `docs/configuration.md` updated, including guidance for public RPC rate limits.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/runner/runner.ts` (`run`, `measure`, `Engine.invoke`, `Engine.runCaseCheck`)
- `src/rpc/client.ts` (`transport`, `simulate`)
- `src/config/config.ts`
- `test/fake-rpc/server.ts` (`FailMode`)
- `test/unit/runner.test.ts`

---

### 25. Deploy a local .wasm to a local network before fuzzing

**Complexity:** High

**Labels:** `wave`, `enhancement`, `rpc`

**Description**

Fuzzing a `.wasm` file today needs `--contract-id` of an already-deployed contract (`resolveRunTarget` in `src/api.ts` throws a `UsageError` otherwise). For a developer iterating on a contract, that means a manual upload and deploy after every build. An opt-in mode could upload the wasm and create a contract instance on a local network, then fuzz it. `scripts/integration.ts` already contains working deploy code (`deploy()`) that can be the starting point.

This changes the tool's security posture: today it never signs or submits transactions. The design must keep that true by default.

**Acceptance criteria**

- [ ] A design comment in the issue is agreed first, covering key handling and the network allow-list.
- [ ] Opt-in flag (for example `--deploy-local`) for `fuzz` and `costs` with a `.wasm` target. It refuses to run unless the network passphrase is the standalone network (`NETWORK_PRESETS.local`), so nothing can be submitted to testnet or mainnet by accident.
- [ ] Uses a throwaway keypair funded by the local friendbot; no user secret key is read or required.
- [ ] Contracts with a `__constructor` that takes arguments produce a clear error (see the constructor issue) unless arguments are provided.
- [ ] The deployed contract ID is printed and added to the report notes.
- [ ] Unit tests with the fake RPC (extended to accept `sendTransaction` for upload/create) and a case in `make integration`.
- [ ] SECURITY.md scope notes and `docs/cli.md` updated to describe exactly when the tool submits transactions.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/api.ts` (`resolveRunTarget`, `fuzz`, `costs`)
- `src/rpc/client.ts`
- `src/config/config.ts` (`NETWORK_PRESETS`)
- `scripts/integration.ts` (`deploy`)
- `test/fake-rpc/server.ts`
- `SECURITY.md`

---

### 26. Stateful multi-call sequence testing on a local network

**Complexity:** High

**Labels:** `wave`, `enhancement`, `checks`

**Description**

Every check runs on a single simulated call against the current ledger state. Simulation never persists state, so a property cannot observe the effect of one call on the next: `ctx.call` in custom properties (see `PropertyContext.call` in `src/checks/properties.ts`) sees the state before the call under test. Many real bugs only show up after a sequence (deposit then withdraw twice, approve then transfer_from, initialize twice). Finding them requires executing calls for real, which is only acceptable on a disposable local network.

**Acceptance criteria**

- [ ] A design comment in the issue is agreed first: command shape (for example a `sequence` command or `fuzz --stateful`), how sequences are generated (fast-check model-based testing with `fc.commands` is a natural fit), how state is reset between sequences (fresh deploy per sequence, building on the local-deploy issue), and how sequences are shrunk and replayed.
- [ ] Only runs against the standalone network passphrase; uses throwaway funded keys; never reads a user secret.
- [ ] Users can write invariants that are checked after every step, with access to the previous and current results.
- [ ] Failing sequences are shrunk and written to replay files that re-execute the same sequence on a fresh deploy.
- [ ] Tests against an extended fake RPC that keeps state across `sendTransaction` calls, plus a case in `make integration` with a planted sequence bug in an example contract.
- [ ] Docs explain the difference from simulation-only fuzzing, the cost (real transactions, slower), and the security implications; SECURITY.md updated.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/runner/runner.ts`
- `src/checks/properties.ts` (`PropertyContext.call`)
- `src/rpc/client.ts`
- `src/runner/replay.ts` (`ReplayFile`)
- `scripts/integration.ts`
- `examples/rust-contracts/vault/src/lib.rs`

---

### 27. Fuzz constructor arguments by deploying per case

**Complexity:** High

**Labels:** `wave`, `enhancement`, `checks`

**Description**

`run` in `src/runner/runner.ts` skips `__constructor` with the reason "constructors run only at deploy time" (`isConstructor`). Constructor validation bugs (accepting a zero admin, an out-of-range fee, an empty list) are therefore never tested. Since a constructor only runs when a contract is created, testing it means simulating or executing contract creation with generated arguments, which is a different transaction type from the invocations the tool builds today.

**Acceptance criteria**

- [ ] A design comment in the issue is agreed first. Investigate whether simulating a `createContractV2` host function with constructor arguments (no submission) is enough to observe traps and contract errors; if so, prefer it over real deployments.
- [ ] `__constructor` is fuzzed with the normal generators and the `no-unexpected-trap` check (other checks where they make sense); boundary cases and shrinking work as for other functions.
- [ ] Requires the wasm to be uploaded on the target network (or a local deploy flow from the local-deploy issue); the requirement is reported clearly when not met.
- [ ] Replay files can describe a constructor case and replay it.
- [ ] Unit tests with the fake RPC extended for contract creation simulation.
- [ ] `docs/checks.md` and `docs/concepts.md` explain how constructors are tested.
- [ ] CHANGELOG.md updated; `make verify` passes.

**Files to look at**

- `src/runner/runner.ts` (`isConstructor`, `run`)
- `src/rpc/client.ts` (`buildInvocation`, `simulate`)
- `src/runner/replay.ts`
- `test/fake-rpc/server.ts`
- `scripts/integration.ts`
