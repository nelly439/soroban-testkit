# Compiled example contracts

Built from [../rust-contracts](../rust-contracts) by `make examples-wasm` (soroban-sdk 23.5.3, `wasm32v1-none`, release profile).

| file               | contents                                    |
| ------------------ | ------------------------------------------- |
| `vault_clean.wasm` | the clean vault                             |
| `vault_buggy.wasm` | the same interface with six planted defects |

They are committed so the quickstart works without Rust. `soroban-testkit inspect` reads their interface directly.
