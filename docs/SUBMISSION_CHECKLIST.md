# Stellar Wave submission checklist

These are the steps to take soroban-testkit from a local folder to a maintained repository applied to the Stellar Wave program on Drips. None of it is approved or guaranteed: acceptance into the program and any rewards are decided by the program.

## 1. Publish the repository

1. Create an empty public GitHub repository (for example `your-org/soroban-testkit`).
2. Done: the repository path `nelly439/soroban-testkit` is already used in the README badges, CONTRIBUTING, CHANGELOG links, the CLI's internal-error message and the issue-template config. If you move the repository, search for `nelly439/soroban-testkit` and update those places.
3. Replace `<maintainer-email>` in [SECURITY.md](../SECURITY.md), and enable **Private vulnerability reporting** under Settings → Security.
4. Commit and push:

   ```sh
   git add -A
   git commit -m "feat: initial release of soroban-testkit 0.1.0"
   git remote add origin git@github.com:your-org/soroban-testkit.git
   git push -u origin main
   ```

5. Check that the **CI** workflow runs and is green on Node 20 and 22.
6. (Optional) Publish to npm: `npm publish` (the name `soroban-testkit` was free when this was written, so check again). Until then, docs that use `npx soroban-testkit` describe the post-publish experience. The quickstart uses `node dist/cli.js` and works without publishing.

## 2. Install the Drips Wave GitHub App and apply

1. Sign in at [drips.network](https://www.drips.network) and open the Wave section for the **Stellar Wave**.
2. Install the Drips Wave GitHub App on your organisation or account, and grant it access to the `soroban-testkit` repository.
3. In Drips, add (sync) the repository so its issues become visible to the program.
4. Apply the repository to the Stellar Wave program with the description below, and follow any program-specific steps shown there. Requirements can change between Waves, so read the current program rules.

## 3. File and label the issues

1. Create labels: `wave`, `good first issue`, `Trivial`, `Medium`, `High` (plus `enhancement`, `bug`, `docs` if you use them).
2. Paste the issues from [WAVE_ISSUES.md](WAVE_ISSUES.md) (8 Trivial, 14 Medium, 5 High). Apply each issue's labels and complexity.
3. Check that they appear in Drips after syncing.

## 4. Pre-flight

- [ ] CI is green on `main`.
- [ ] `npm ci && make verify` passes locally and prints `PASS: all 6 steps passed`.
- [ ] The README quickstart was tested from a clean clone of the **published** repository.
- [ ] `LICENSE` (MIT) is present.
- [ ] Issues are drafted, filed and labelled by complexity.
- [ ] `CONTRIBUTING.md` is complete (setup, layout, tests, style, commits, claiming, review, Wave section).
- [ ] `SECURITY.md` has a real contact and private reporting is enabled.
- [ ] `CODE_OF_CONDUCT.md` is present.
- [ ] Repository description, topics (`stellar`, `soroban`, `fuzzing`, `testing`) and website link are set.
- [ ] Optional: `make integration` re-run on your machine, with the result noted in the PR or release notes.

## 5. Project description (for the application form, under 100 words)

> soroban-testkit tests Soroban smart contracts without hand-written inputs. It reads a contract's interface from its wasm or contract ID, generates boundary and seeded random inputs for every function, and runs them through Stellar RPC simulateTransaction, so chain state is never changed. It reports traps, non-determinism, unexpected state writes, broken custom invariants and CPU budget overruns, each with a shrunk counterexample, seed and replay file. Cost baselines let CI fail when a function gets more expensive. It is a TypeScript CLI and library with JSON, Markdown and JUnit output, MIT-licensed.
