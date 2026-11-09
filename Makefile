# soroban-testkit developer commands. Run `make help` for a list.
.DEFAULT_GOAL := help
.PHONY: help setup lint format typecheck test e2e coverage build docs-check demo demo-rpc verify integration examples-wasm clean

help: ## list targets
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-14s %s\n", $$1, $$2}'

setup: ## install dependencies from the lockfile
	npm ci

lint: ## eslint + prettier --check
	npm run lint

format: ## apply prettier formatting
	npm run format

typecheck: ## tsc --noEmit (strict)
	npm run typecheck

test: ## unit tests (includes fake-RPC tests over real HTTP)
	npm test

e2e: ## planted-bug end-to-end test through the real CLI process
	npm run test:e2e

coverage: ## unit tests with coverage (fails below 85% lines on src/)
	npm run coverage

build: ## compile to dist/ with tsup
	npm run build

docs-check: ## verify docs match the code (config keys, CLI flags, checks, make targets, links)
	npm run docs:check

demo: build ## run real commands against the bundled fake RPC; saves docs/demo-output/
	npm run demo

demo-rpc: ## start the bundled fake RPC on http://127.0.0.1:8787 (Ctrl+C to stop)
	npm run demo:rpc

verify: ## lint, typecheck, unit tests + coverage, e2e, build, docs-check, with a PASS/FAIL summary
	npm run verify

integration: build ## OPTIONAL: real local network (needs Docker; Rust if examples/wasm is missing)
	npm run integration

examples-wasm: ## rebuild examples/wasm/*.wasm from examples/rust-contracts (needs Rust + wasm32v1-none)
	./examples/rust-contracts/build.sh

clean: ## remove build and test artifacts
	rm -rf dist coverage .verify .soroban-testkit examples/*/.soroban-testkit
