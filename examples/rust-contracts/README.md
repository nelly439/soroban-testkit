# Example contracts

`vault/` is a small Soroban contract used by soroban-testkit's docs, demo and real-network integration test.

- Built normally, it is the **clean** vault.
- Built with `--features buggy`, it carries **six planted defects**, each marked `PLANTED BUG` in [vault/src/lib.rs](vault/src/lib.rs): a division by zero, an `unwrap()` on an empty vec, a getter that writes storage, a PRNG-dependent result, 40% more CPU in `compute`, and a missing balance check in `transfer`.

```sh
./build.sh          # or: make examples-wasm (from the repository root)
```

This writes `../wasm/vault_clean.wasm` and `../wasm/vault_buggy.wasm`. It needs Rust with the `wasm32v1-none` target (`rustup target add wasm32v1-none`).

The contract uses soroban-sdk **23.5.3** on purpose. soroban-sdk 25 and later refuse to build with plain `cargo` and require `stellar contract build`. 23.5.3 builds with cargo alone, and contracts built with it run on current networks: `make integration` deployed them on a stellar-rpc 30 / protocol 30 local network.
