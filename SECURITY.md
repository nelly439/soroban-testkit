# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

Fixes are released as new patch versions of the latest supported minor version.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (private vulnerability reporting / security advisories). This keeps the report visible only to the maintainers until a fix is published.

If you cannot use GitHub, email: `<maintainer-email>` <!-- maintainers: replace with a real address before publishing -->

Include, if you can:

- the soroban-testkit version (`soroban-testkit --version`) and Node.js version
- the command you ran and the config file (remove any private RPC URLs or tokens)
- what happened and what you expected
- a proof of concept or steps to reproduce

## What to expect

- We acknowledge your report within 3 business days.
- We aim to send an assessment (accepted, needs more information, or out of scope) within 10 business days.
- For accepted reports we agree on a disclosure date with you, publish a fixed release and a GitHub security advisory, and credit you unless you prefer otherwise.

## Scope notes

These points describe what the tool does and does not do, to help judge whether something is a vulnerability.

- **Read-only RPC use.** soroban-testkit only calls these Stellar RPC methods: `simulateTransaction`, `getLedgerEntries` (to download contract code and, if a source account is configured, to load that account), `getHealth` and `getNetwork`. It never signs transactions, never submits transactions, and never needs a secret key. The source account option takes a public key (`G...`) only. If you find a code path that signs or submits anything, or reads a secret key, that is a vulnerability.
- **Config and property files are code.** `soroban-testkit.config.ts`, `.mjs`, `.js` and custom property files are imported and executed with the same permissions as the tool. Treat them like any script you run: do not run the tool with config or property files from sources you do not trust. Executing those files as designed is not a vulnerability; executing code from other inputs (spec files, `.wasm` files, replay files, baseline files, RPC responses) would be.
- **Untrusted inputs.** Contract specs (from `.wasm`, `.json` or the network), RPC responses, replay files and baseline files are parsed as data. Crashes are bugs; code execution, path traversal outside the configured output directories, or unbounded resource use triggered by such inputs are security issues.
- **Report contents.** Reports and replay files contain contract IDs, generated arguments and RPC error messages. They do not contain secrets unless you put secrets in the config (for example an RPC URL with an API key) and then publish the report.
- **Fake RPC.** The fake RPC server under `test/fake-rpc/` (also started by `npm run demo:rpc`) is a test tool. It is not part of the published package, does no authentication, and must not be exposed on a public network interface.
