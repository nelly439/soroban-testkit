# Architecture

## Data flow

```mermaid
sequenceDiagram
  participant CLI as cli/program.ts
  participant API as api.ts
  participant Spec as spec/
  participant Run as runner/runner.ts
  participant Gen as generate/
  participant RPC as rpc/client.ts
  participant Chk as checks/
  participant Base as baseline/
  participant Rep as report/

  CLI->>API: fuzz / costs / inspect (resolved config)
  API->>RPC: getNetwork (passphrase check), getHealth
  API->>Spec: load spec (wasm / JSON / getLedgerEntries)
  API->>Run: run(spec, contractId, simulator, config, seed)
  loop every function
    Run->>Gen: boundaryCases + fc.sample(seed) (measurement set)
    Run->>RPC: simulateTransaction (cached per input)
    loop every enabled check
      Run->>Gen: fast-check property: examples = boundary cases, numRuns = boundary + runs
      Run->>Chk: evaluate(invocation)  (deterministic re-simulates; properties may ctx.call)
      Chk-->>Run: violation? -> fast-check shrinks -> finding + replay file
    end
  end
  Run->>Base: computeCosts / compareCosts (cost-regression)
  Run-->>CLI: RunReport
  CLI->>Rep: terminal / JSON / Markdown / JUnit
```

| module                           | responsibility                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/spec/](../src/spec)         | XDR `ScSpecEntry` ↔ a plain JSON model (`ContractSpec`, `TypeRef`). Reading wasm custom sections uses `contract.Spec.fromWasm` from `@stellar/stellar-sdk`                  |
| [src/generate/](../src/generate) | type → fast-check arbitrary and boundary values; typed native ↔ `ScVal` encoding (struct and map key ordering, union and enum encodings follow `soroban-sdk`)               |
| [src/rpc/](../src/rpc)           | builds the invocation transaction, calls `simulateTransaction`, classifies the outcome, parses resources; retries, then turns transport failures into `RpcUnavailableError` |
| [src/checks/](../src/checks)     | per-call checks (`CaseCheck`) and custom-property loading                                                                                                                   |
| [src/runner/](../src/runner)     | orchestration: measurement set, simulation cache, one fast-check property per (function, check), shrinking, replay files, baseline comparison                               |
| [src/baseline/](../src/baseline) | cost statistics and baseline files                                                                                                                                          |
| [src/report/](../src/report)     | renderers                                                                                                                                                                   |
| [src/config/](../src/config)     | schema, validation, file and env loading                                                                                                                                    |
| [src/cli/](../src/cli)           | commander program and exit-code mapping                                                                                                                                     |

## Design decisions and trade-offs

**Simulation, not a local host.** Using RPC `simulateTransaction` means the code under test runs in the real Soroban host with real metering, against real ledger state, without a Rust toolchain or contract source. The cost: no state persists between calls (no sequences), every case is a network round trip, and the tool sees only what the RPC returns (for example no memory figure on stellar-rpc 30).

**One fast-check property per (function, check).** Each check shrinks toward _its own_ minimal failure, so one function can report a trap at `amount=0` and a property violation at `amount=1001` separately. Sharing a seed and a cache keeps the RPC cost close to one simulation per distinct input. The alternative, one property per function, would let shrinking jump between unrelated failures.

**Boundary values as fast-check `examples`.** Boundaries always run first. Because every mapped arbitrary has an _unmapper_, fast-check can shrink a failing boundary example too (`i128::MAX` → `1001`).

**A separate, fixed measurement set for costs.** Cost statistics come from boundary cases plus `fc.sample(seed, runs)`, not from whatever the checks happened to try while shrinking. Two runs with the same seed and runs therefore measure exactly the same inputs, which is what makes `cost-regression` comparisons meaningful. `fc.check`'s first random values are the same as `fc.sample`'s for the same seed, so the measurement mostly hits the cache.

**Max, not mean, for regressions.** The maximum is the cost a user can actually be charged. The mean depends on the input mix.

**Strict outcome classification.** Only error codes declared in the spec count as intended. Everything else is a trap. Transport errors abort the run with exit `3` and are never findings, including when they happen inside a custom property.

**Plain JSON spec model.** The rest of the code never touches XDR spec objects, which makes fixtures, `inspect --json`, and tests simple.

## Testing strategy and what it proves

| layer                   | where                                                                   | proves                                                                                                                                                                                                                                                                                     | does not prove                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| unit tests              | [test/unit/](../test/unit)                                              | parsing of every spec type, generators and boundaries for every type, encoding round trips, seeds, shrinking, each check, config, baseline maths, reporters (file snapshots), CLI exit codes, examples                                                                                     | anything about real networks                                                                                      |
| synthetic wasm          | [test/fixtures/wasm-builder.ts](../test/fixtures/wasm-builder.ts)       | spec loading works on real wasm bytes (`WebAssembly.validate` accepts them) without Rust                                                                                                                                                                                                   | that real compilers emit the same layout; the real compiled examples in `examples/wasm/` are also parsed in tests |
| fake RPC over HTTP      | [test/fake-rpc/](../test/fake-rpc)                                      | the real HTTP client, transaction building, argument encoding (the fake re-decodes and checks every argument is canonical for its type), response parsing, classification, checks, shrinking, replay and reports all work end to end on RPC-shaped responses, including transport failures | real host behaviour: contract logic, costs and footprints in the fake are **scripted in TypeScript**              |
| planted-bug e2e         | [test/e2e/planted-bugs.test.ts](../test/e2e/planted-bugs.test.ts)       | through the real CLI process: exactly the six planted defects, zero false positives on the clean contract, identical replays, exit `3` on RPC failure, baseline update/check                                                                                                               | real network behaviour                                                                                            |
| real network (optional) | `make integration`, [scripts/integration.ts](../scripts/integration.ts) | real Rust contracts ([examples/rust-contracts/](../examples/rust-contracts)) deployed on a local `stellar/quickstart` network: planted bugs flagged, clean contract passes                                                                                                                 | other RPC versions or providers                                                                                   |

The fake RPC lives in `test/`, outside `src/`, and is not shipped in the package. By default, `cost` (memory) is left out of its responses, matching stellar-rpc 30.

## Known limitations

- **No multi-call sequences.** Every simulation starts from current state.
- **Recording auth.** `require_auth()` always succeeds in simulation, so missing auth checks are only found by a custom property.
- **Memory** is unavailable from stellar-rpc 30, so memory budgets and regressions are skipped.
- **`MuxedAddress`** parameters only get `G...`/`C...` addresses.
- **Map key ordering** matches the host for numbers, strings, symbols, bytes, booleans, addresses and vectors of those. Other key types are ordered by XDR bytes, which may differ from the host.
- **Constructors** are skipped.
- **Spec mismatch detection** between a local wasm and the deployed contract compares function names only.
- **Throughput:** simulations run sequentially, one at a time.
- **Events, auth entries and `restorePreamble`** in simulation responses are not inspected yet.

Most of these are open issues in [WAVE_ISSUES.md](WAVE_ISSUES.md).
