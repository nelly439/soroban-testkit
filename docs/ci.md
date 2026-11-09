# Using soroban-testkit in CI

The usual setup:

1. **On every pull request**, fuzz the contract and check its costs against a committed baseline. Either step fails the job.
2. **When a cost change is intended**, update the baseline in the same PR so reviewers see the cost diff.

Exit codes make this easy: `0` clean, `1` findings or regression, `2` misconfiguration, `3` RPC unreachable (an infrastructure problem, not a contract bug).

## What you need

- A deployed build of the contract under test. Simulation needs a contract on some network. Common choices are a testnet deployment made by an earlier job step, or a local network started in the job (`stellar/quickstart`; see [scripts/integration.ts](../scripts/integration.ts) for a complete, working example of starting one and deploying with the JS SDK).
- `soroban-testkit.config.json` and, for `cost-regression`, a committed baseline file.

## GitHub Actions example

```yaml
name: contract-tests
on: [pull_request]

jobs:
  soroban-testkit:
    runs-on: ubuntu-latest
    env:
      STELLAR_RPC_URL: https://soroban-testnet.stellar.org
      STELLAR_NETWORK_PASSPHRASE: Test SDF Network ; September 2015
      CONTRACT_ID: ${{ vars.CONTRACT_ID }} # set by your deploy step or a repository variable
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Fuzz
        run: >
          npx --yes soroban-testkit fuzz "$CONTRACT_ID"
          --seed 12345 --runs 200
          --junit reports/fuzz.xml --markdown reports/fuzz.md

      - name: Cost regression gate
        if: always()
        run: >
          npx --yes soroban-testkit costs "$CONTRACT_ID"
          --check-baseline --baseline .soroban-testkit/baseline.json
          --junit reports/costs.xml

      - name: Job summary
        if: always()
        run: cat reports/fuzz.md >> "$GITHUB_STEP_SUMMARY" || true

      - name: Publish test results
        if: always()
        uses: mikepenz/action-junit-report@v4
        with:
          report_paths: reports/*.xml

      - name: Upload replay files
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: soroban-testkit-replays
          path: .soroban-testkit/replays/
```

Notes:

- **Fixed seed or random seed?** A fixed `--seed` makes CI fully reproducible, and the same inputs are tested every time. A random seed explores more over time, and every failure still prints its seed and writes a replay file. Many teams use a fixed seed on PRs and a random one in a nightly job.
- **Baselines** should be measured on the same network you check against. CPU costs depend on the protocol's cost model, so a local network and testnet can differ when they run different protocol versions, and fees differ anyway. `costs --check-baseline` reuses the baseline's seed and runs automatically.
- **Updating the baseline** after an intended change:

  ```sh
  npx soroban-testkit costs "$CONTRACT_ID" --update-baseline
  git add .soroban-testkit/baseline.json && git commit -m "chore: update cost baseline"
  ```

- **Exit code 3** means the RPC was down or rate-limiting. You may want to retry the job instead of treating it as a failed test. The default `retries` (2) already absorbs short glitches.
- **Rate limits:** public RPCs throttle. Lower `--runs`, disable `deterministic` (it doubles the calls), or run your own RPC. See [troubleshooting](troubleshooting.md#rpc-rate-limits).

## This repository's own CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs lint, type-check, unit tests with coverage, the planted-bug e2e test, the build and `make docs-check` on Node 20 and 22. It also runs the e2e test against the built `dist/cli.js`.
