# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-09

### Added

- Spec loading from contract `.wasm` files (`contractspecv0`), deployed contract IDs (over RPC), and JSON spec files (three formats).
- `inspect` command (text and `--json`).
- Generators and boundary values for every Soroban spec type, including user-defined structs, unions, enums and error enums.
- `fuzz` command: seeded, boundary-first fuzzing through `simulateTransaction`, with fast-check shrinking, replay files and `--replay`.
- Built-in checks: `no-unexpected-trap`, `deterministic`, `read-only`, `budget`, `cost-regression`, `custom-property` (with `ctx.call` for cross-function properties).
- `costs` command with `--update-baseline` and `--check-baseline`.
- Terminal, JSON, Markdown and JUnit XML reporters.
- Configuration via `soroban-testkit.config.{ts,mjs,js,json}`, network presets and `STELLAR_*` environment variables.
- Exit codes: 0 clean, 1 findings, 2 usage/config error, 3 RPC unavailable.
- Typed library API.
- Fake Stellar RPC test tool, planted-bug end-to-end test, optional real-network integration test (`make integration`).
- Example vault contract in Rust (clean and buggy builds), custom-property examples, documentation.

[Unreleased]: https://github.com/nelly439/soroban-testkit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nelly439/soroban-testkit/releases/tag/v0.1.0
