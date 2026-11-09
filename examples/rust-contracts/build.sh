#!/usr/bin/env bash
# Builds the clean and buggy vault wasm files into examples/wasm/.
# Requires Rust with the wasm32v1-none target (rustup target add wasm32v1-none).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../wasm"
mkdir -p "$out"
cd "$here"
cargo build --release --target wasm32v1-none -p vault
cp target/wasm32v1-none/release/vault.wasm "$out/vault_clean.wasm"
cargo build --release --target wasm32v1-none -p vault --features buggy
cp target/wasm32v1-none/release/vault.wasm "$out/vault_buggy.wasm"
ls -l "$out"
