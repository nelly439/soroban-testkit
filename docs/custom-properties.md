# Custom properties

Built-in checks catch crashes, writes and cost problems. A **custom property** states something specific to your contract ("a transfer never leaves a negative balance", "only the admin can mint") and lets soroban-testkit search for an input that breaks it.

## Writing a property

A property file is a TypeScript or JavaScript module whose default export is one property or an array of them:

```ts
import type { Property } from 'soroban-testkit';

export default [
  {
    name: 'sender balance after transfer is never negative', // shown in reports
    function: 'transfer', // a name, an array of names, or '*'
    check: (args, result, ctx) => (result as bigint) >= 0n,
  },
] satisfies Property[];
```

`defineProperties([...])` (a runtime identity helper exported by the package) works too. With `import type` the file does not need the package at runtime.

Register files in the config (`"properties": ["properties/token.ts"]`, relative to the config file) or pass `--properties file.ts` (repeatable).

### The `check` function

```ts
check(args, result, ctx) => boolean | string | void | Promise<...>
```

| argument              | content                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `args`                | the call's arguments keyed by parameter name, as native JS values ([generators.md](generators.md#native-value-representation)): `bigint` for 64-bit and larger integers, `string` for addresses and symbols, `Uint8Array` for bytes |
| `result`              | the decoded return value. `Result<T, E>` is unwrapped to `T`, because an `Err` fails the call and never arrives as a value. `undefined` if the call failed                                                                          |
| `ctx.function`        | the function under test                                                                                                                                                                                                             |
| `ctx.outcome`         | `{ kind: 'success' }`, `{ kind: 'contract-error', code, name }` (for example `name: 'TokenError::Unauthorized'`), or `{ kind: 'trap', error }`                                                                                      |
| `ctx.resources`       | CPU, footprint and fee numbers of a successful call (`null` otherwise)                                                                                                                                                              |
| `ctx.call(fn, args?)` | simulates another function on the same contract. `args` is an object keyed by parameter name or a positional array. Returns `{ outcome, result, resources }`                                                                        |

Verdicts: `true` or `undefined` pass. `false` fails with "returned false". A **string** fails with that string as the message. Throwing fails with the error message.

### Options

| field             | default | meaning                                                                                                                                |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `includeFailures` | `false` | also evaluate the property when the call failed (contract error or trap); `result` is then `undefined` and `ctx.outcome` tells you why |

### Important limits

- **No state carries over.** Each simulation starts from current ledger state. `ctx.call('balance', ...)` after a `transfer` does **not** see the transfer. Express properties in terms of the call's own result, or of state that already exists.
- `ctx.call` always runs a **fresh** simulation (never cached), so it costs one RPC request each time.
- Transport errors inside `ctx.call` abort the whole run with exit code `3`. They are never reported as a property failure.
- Properties only see generated inputs. Add important addresses (an admin, a known holder) to `generators.addresses` so they are tried.
- Property files are executed as code. Only load files you trust.

## Three runnable examples

The files are in [examples/custom-properties/](../examples/custom-properties), together with [a config](../examples/custom-properties/soroban-testkit.config.json) that loads all three and adds the token admin to `generators.addresses`. They target the **demo token** hosted by the bundled fake RPC. The demo token behaves correctly except for one planted bug: `mint` does not check its caller. A unit test ([test/unit/examples.test.ts](../test/unit/examples.test.ts)) runs all three on every `make test`.

```sh
npm run build
npm run demo:rpc > demo-rpc.log 2>&1 &
sleep 3
node dist/cli.js fuzz CBSGK3LPFV2G623FNYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUM4 \
  --config examples/custom-properties/soroban-testkit.config.json --seed 1
kill %1
```

### 1. Token balances: [token-balances.ts](../examples/custom-properties/token-balances.ts)

```ts
export default [
  {
    name: 'sender balance after transfer is never negative',
    function: 'transfer',
    check: (_args, balanceAfter) => (balanceAfter as bigint) >= 0n,
  },
  {
    name: 'no balance exceeds the total supply',
    function: 'balance',
    check: async (_args, balance, ctx) => {
      const { result: supply } = await ctx.call('total_supply');
      if ((balance as bigint) <= (supply as bigint)) return true;
      return `balance ${String(balance)} is larger than the total supply ${String(supply)}`;
    },
  },
] satisfies Property[];
```

Both pass on the demo token. The same balance property on the buggy vault finds `amount=1001` (see [checks.md](checks.md#custom-property)).

### 2. Access control: [access-control.ts](../examples/custom-properties/access-control.ts)

```ts
export default [
  {
    name: 'only the admin can mint',
    function: 'mint',
    includeFailures: true,
    check: async (args, _result, ctx) => {
      const { result: admin } = await ctx.call('admin');
      if (args.caller === admin) return true;
      if (
        ctx.outcome.kind === 'contract-error' &&
        ctx.outcome.name === 'TokenError::Unauthorized'
      ) {
        return true;
      }
      return `non-admin caller was not rejected (outcome: ${ctx.outcome.kind})`;
    },
  },
] satisfies Property[];
```

This finds the planted bug ([demo-output/fuzz-token-properties.txt](demo-output/fuzz-token-properties.txt)):

```text
1) custom-property · mint · "only the admin can mint"
   property "only the admin can mint" failed: non-admin caller was not rejected (outcome: success) (result: 1000)
   counterexample: caller="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", to="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", amount=0  (minimal as found)
   seed: 1
```

Note that simulation records authorization instead of enforcing signatures, so `require_auth()` alone never fails in simulation. This property checks the contract's own _logic_ (rejecting non-admins). It does not check signature enforcement.

### 3. Idempotent reads: [idempotent-reads.ts](../examples/custom-properties/idempotent-reads.ts)

```ts
export default [
  {
    name: 'reads are idempotent and write nothing',
    function: ['admin', 'total_supply', 'balance'],
    check: async (args, result, ctx) => {
      const writes = ctx.resources?.writeEntries ?? 0;
      if (writes > 0) return `a read wrote ${writes} ledger entr${writes === 1 ? 'y' : 'ies'}`;
      const again = await ctx.call(ctx.function, args);
      return (
        same(again.result, result) ||
        `second read returned ${String(again.result)}, first ${String(result)}`
      );
    },
  },
] satisfies Property[];
```

It passes on the demo token. It is a property-level version of the `read-only` and `deterministic` checks, useful when you want one rule over many getters.
