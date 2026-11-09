# Contributing to soroban-testkit

Thanks for helping. This guide gets you from clone to a passing `make verify` in under 10 minutes, and explains how issues and reviews work, including for the Stellar Wave program.

## Setup (about 5 minutes)

Requirements: **Node.js 20+**, npm, git, and make. You do **not** need Rust, Docker or a Stellar network for the normal workflow.

```sh
git clone https://github.com/nelly439/soroban-testkit.git
cd soroban-testkit
make setup      # npm ci (exact versions from package-lock.json)
make verify     # lint, typecheck, unit tests + coverage, e2e, build, docs-check
```

`make verify` ends with a PASS/FAIL summary. If it passes on your machine, CI should pass too. `make help` lists every target.

## Repository layout

```text
src/
  spec/        contract spec loading (wasm, JSON, RPC) and the plain ContractSpec model
  generate/    spec types -> fast-check arbitraries, boundary values, ScVal encoding
  rpc/         simulateTransaction client, outcome classification, resource parsing
  checks/      built-in checks and custom-property loading
  runner/      orchestration, caching, shrinking, replay files
  report/      terminal, JSON, Markdown, JUnit and inspect renderers
  baseline/    cost statistics and baseline files
  config/      config schema, validation, file + env loading
  cli/         commander program (program.ts) and entry point (main.ts)
  api.ts       high-level functions used by the CLI
  index.ts     public API (everything exported here needs TSDoc)
test/
  unit/        unit tests (vitest), including fake-RPC tests over real HTTP
  e2e/         planted-bug end-to-end test through the real CLI process
  fixtures/    synthetic wasm builder, spec fixtures
  fake-rpc/    fake Stellar RPC server + scripted contracts (TEST TOOL, not shipped)
examples/
  rust-contracts/     the vault contract in Rust (clean, and buggy with --features buggy)
  wasm/               compiled example contracts
  vault-demo/         config + property for the quickstart
  custom-properties/  three runnable property examples
scripts/       verify, docs-check, demo, demo-rpc, integration
docs/          user documentation
```

## Running tests

| what             | command                                     | notes                                                                                                                                                                                           |
| ---------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit tests       | `make test`                                 | about 10 s; starts fake RPC servers on random ports                                                                                                                                             |
| one file         | `npx vitest run test/unit/generate.test.ts` |                                                                                                                                                                                                 |
| watch mode       | `npx vitest test/unit`                      |                                                                                                                                                                                                 |
| coverage         | `make coverage`                             | fails below 85% line coverage on `src/`; HTML report in `coverage/`                                                                                                                             |
| planted-bug e2e  | `make e2e`                                  | spawns the real CLI; `STK_E2E_CLI=dist` tests `dist/cli.js` instead of the sources                                                                                                              |
| docs consistency | `make docs-check`                           | config keys, CLI flags, checks, make targets, links, TSDoc, API docs                                                                                                                            |
| demo output      | `make demo`                                 | regenerates `docs/demo-output/`. Commit the changes if the output changed                                                                                                                       |
| real network     | `make integration`                          | optional. Needs Docker (Rust only if `examples/wasm` is missing). Uses port 8000, or `STK_INTEGRATION_PORT=8011 make integration`. It prints SKIPPED and exits 0 when prerequisites are missing |
| example wasm     | `make examples-wasm`                        | rebuild `examples/wasm/` (Rust + `wasm32v1-none` target)                                                                                                                                        |

Reporter output is covered by file snapshots in `test/unit/__snapshots__/`. If you change output on purpose, run `npx vitest run test/unit/report.test.ts -u` and review the diff.

### Adding a check

1. Implement a `CaseCheck` in `src/checks/checks.ts` (or a function-level check in the runner like `cost-regression`).
2. Add its name to `CHECK_NAMES` in `src/config/config.ts` and wire it in `caseChecksFor`.
3. Unit-test it in isolation (`test/unit/checks.test.ts`), and add a planted defect to the fake contracts if it needs end-to-end proof.
4. Document it in `docs/checks.md` (a `## \`name\``section is required by`make docs-check`) and `docs/concepts.md`.

## Code style

- TypeScript strict mode, ESM, Node 20+. No `any` unless unavoidable; prefer `unknown` plus narrowing.
- Prettier formats (`make format`); ESLint lints (`make lint`). CI rejects unformatted code.
- Every symbol exported from `src/index.ts` needs a TSDoc comment (`make docs-check` enforces it).
- Errors that end a command are `TestkitError` subclasses with the right exit code. Never turn a transport failure into a finding.
- No placeholder or TODO code in features the docs describe. If something is unfinished, it belongs in an issue.

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org): `feat: add SARIF reporter`, `fix(rpc): retry on HTTP 502`, `docs: clarify read-only caveat`, `test: ...`, `chore: ...`. Use `!` or a `BREAKING CHANGE:` footer for breaking changes. Add a line to `CHANGELOG.md` under **Unreleased** for anything user-visible.

## Claiming an issue

1. Pick an open issue. Ready-to-file issues live in [docs/WAVE_ISSUES.md](docs/WAVE_ISSUES.md) and are labelled `Trivial`, `Medium` or `High`.
2. Comment "I'd like to work on this" and briefly describe your approach. For High issues, wait for a maintainer to confirm the approach before writing much code.
3. A maintainer assigns the issue to you. Please open a draft PR within **5 days**. Assignments without activity for 7 days may be released so others can pick them up.
4. One issue per PR, please.

## How PR review works

- Open the PR with the template filled in and `Closes #<issue>`.
- CI must be green (`make verify` on Node 20 and 22, plus the e2e test against the build).
- A maintainer reviews against the issue's acceptance criteria: tests added, docs updated, `make docs-check` passing, and no unrelated changes.
- We aim for a **first review within 2 business days** and follow-ups within 2 business days of your update.
- Small follow-up nits may be fixed by the maintainer directly to save a round trip, and we will say so in the review.
- PRs are squash-merged with the conventional-commit title.

## Stellar Wave

soroban-testkit takes part in the [Stellar Wave](https://www.drips.network/wave) program on Drips.

- **Issue scoping:** every Wave issue states the problem, acceptance criteria, files to look at, and a complexity. If an issue turns out bigger than its label, tell us in the issue and we will split it or relabel it before you continue. You will not be penalised for scope we got wrong.
- **Complexity levels:**
  - **Trivial**: a few hours at most; small code or docs change, clear acceptance criteria. Good first issues.
  - **Medium**: a focused feature or fix with tests and docs, usually touching one or two modules.
  - **High**: design work across several modules (for example stateful sequences or parallel simulation). Discuss the approach in the issue first.
- **Review turnaround:** first review within 2 business days during Wave periods. If a review is late, ping the maintainers in the PR.
- **Done means merged:** an issue counts as complete when its PR is merged with all acceptance criteria met.

## Code of conduct and security

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.
