#!/bin/sh
set -e
RUSTFLAGS="-C target-feature=+simd128 -C link-arg=-zstack-size=4096" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/diff.wasm .
