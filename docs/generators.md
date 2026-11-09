# Generators

For every parameter, soroban-testkit derives two things from the declared spec type:

1. an ordered list of **boundary values**, which are always run first, and
2. a [fast-check](https://fast-check.dev) **arbitrary** for random values, which also knows how to shrink.

The implementation is [src/generate/arbitraries.ts](../src/generate/arbitraries.ts). ScVal encoding is in [src/generate/scval.ts](../src/generate/scval.ts).

## Boundary values

| spec type                      | boundary values, in order                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `bool`                         | `false`, `true`                                                                                                                           |
| `u32`                          | 0, 1, 4294967295, 4294967294                                                                                                              |
| `i32`                          | 0, 1, 2147483647, 2147483646, -2147483648, -2147483647, -1                                                                                |
| `u64`, `timepoint`, `duration` | 0, 1, 2^64-1, 2^64-2                                                                                                                      |
| `i64`                          | 0, 1, 2^63-1, 2^63-2, -2^63, -2^63+1, -1                                                                                                  |
| `u128` / `u256`                | 0, 1, max, max-1                                                                                                                          |
| `i128` / `i256`                | 0, 1, max, max-1, min, min+1, -1                                                                                                          |
| `Symbol`                       | `""`, `"a"`, `"_"`, 32 × `"a"` (the maximum symbol length)                                                                                |
| `String`                       | `""`, `"a"`, `maxStringLength` × `"x"`, `"é"`, `"\u0000"`                                                                                 |
| `Bytes`                        | empty, `[0x00]`, `[0xff]`, `maxBytesLength` zero bytes                                                                                    |
| `BytesN<n>`                    | n zero bytes, n `0xff` bytes                                                                                                              |
| `Address`, `MuxedAddress`      | all-zero account `GAAA…AWHF`, all-zero contract `CAAA…`, all-0xff account, all-0xff contract, then `generators.addresses`                 |
| `Vec<T>`                       | `[]`, then single-element vectors of the first three boundary values of `T`                                                               |
| `Map<K, V>`                    | empty map, then single-entry maps with the first two boundary keys                                                                        |
| `Option<T>`                    | `None`, then the boundary values of `T`                                                                                                   |
| `Result<T, E>`                 | `Ok` of each boundary of `T`, then `Err` of the first two of `E`                                                                          |
| tuple, struct                  | all elements/fields at their first boundary, then each one varied over its own boundaries, then all of them at the k-th boundary together |
| union                          | each case once (void cases as is, tuple cases with first boundaries), then tuple-case payload variations                                  |
| enum, error enum               | every declared value                                                                                                                      |
| `Error`                        | contract error codes 0 and 1                                                                                                              |
| `Val`                          | `false`, `0u32`, `0i128`, `""` (symbol)                                                                                                   |
| `()`                           | `()`                                                                                                                                      |

A function's boundary cases combine its parameters the same way as a struct's fields. They are capped at `generators.maxBoundaryCases` (200), and each type's list at 12 values.

## Random values

| spec type                 | random values                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| integers                  | uniformly over the full range, biased toward small and extreme values (fast-check's default bias)       |
| `Symbol`                  | 0-32 characters from `[A-Za-z0-9_]`                                                                     |
| `String`                  | 0 to `maxStringLength` characters, any Unicode code point, encoded as UTF-8                             |
| `Bytes`                   | 0 to `maxBytesLength` random bytes                                                                      |
| `BytesN<n>`               | exactly n random bytes                                                                                  |
| `Address`, `MuxedAddress` | random 32-byte account (`G...`) or contract (`C...`) keys, plus `generators.addresses`                  |
| `Vec<T>`                  | 0 to `maxCollectionLength` elements                                                                     |
| `Map<K, V>`               | 0 to `maxCollectionLength` entries with **unique** keys, encoded **sorted by key** as the host requires |
| `Option<T>`               | `None` or a `T`                                                                                         |
| struct                    | each field independently                                                                                |
| union / enum              | a random case / value                                                                                   |

Recursive user types stop growing after `generators.maxDepth` (4) levels: unions are limited to their void cases, vectors and maps to empty, and options to `None`.

**Not generated:** muxed `M...` addresses (`MuxedAddress` parameters get `G...`/`C...` addresses), invalid UTF-8 strings, and values that do not match the declared type. Every input is valid for its declared type, because the goal is to find bugs reachable by well-formed calls.

## Shrinking

When a check fails, fast-check shrinks the failing input: integers move toward 0, collections lose elements, strings get shorter, addresses move toward the all-zero key. Boundary-case failures are shrunk too, so `i128::MAX` failing a balance check becomes the smallest failing amount (`1001` in the vault demo).

## Native value representation

These are the JavaScript values your [custom properties](custom-properties.md) receive in `args` and `result`, and the values in JSON reports (with bigints written as `{"$bigint": "..."}` and bytes as `{"$bytes": "<hex>"}`).

| spec type                                                             | JS value                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `bool`                                                                | `boolean`                                                          |
| `u32`, `i32`                                                          | `number`                                                           |
| `u64`, `i64`, `u128`, `i128`, `u256`, `i256`, `timepoint`, `duration` | `bigint`                                                           |
| `Symbol`, `String`                                                    | `string`                                                           |
| `Bytes`, `BytesN<n>`                                                  | `Uint8Array`                                                       |
| `Address`, `MuxedAddress`                                             | `string` strkey (`G...` / `C...`)                                  |
| `Vec<T>`, tuples                                                      | `Array`                                                            |
| `Map<K, V>`                                                           | `Array<[K, V]>`                                                    |
| `Option<T>`                                                           | the value, or `null` for `None`                                    |
| `Result<T, E>` (as a parameter)                                       | `{ ok: T }` or `{ err: E }`                                        |
| struct                                                                | object keyed by field name (tuple structs: keys `"0"`, `"1"`, ...) |
| union                                                                 | `{ tag: "CaseName", values: [...] }`                               |
| enum, error enum                                                      | `number`                                                           |
| `()`                                                                  | `null`                                                             |
| `Val`                                                                 | `{ $type: "u32", value: 0 }`                                       |

Encoding follows `soroban-sdk`: structs become maps with symbol keys sorted by name (tuple structs become vectors), unions become `[Symbol(case), ...payload]`, enums become `u32`, and error enums become `Error(Contract, code)`.
