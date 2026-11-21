#!/usr/bin/env bash
# Rebuilds the in-browser Revit reader (public/rvt/rvt.js + rvt_bg.wasm) from
# the rvt-rs source. You only need this to move to a newer rvt-rs release:
# the files in public/rvt/ are already built.
#
# Needs: git, Rust (rustup, cargo) and curl. Run from the project root:
#   npm run build:rvt-wasm            # the pinned release
#   RVT_RS_TAG=v0.18.0 npm run build:rvt-wasm
set -euo pipefail

TAG="${RVT_RS_TAG:-v0.17.0}"
REPO="https://github.com/DrunkOnJava/rvt-rs.git"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Cloning rvt-rs $TAG"
git clone --quiet --depth 1 --branch "$TAG" "$REPO" "$WORK/rvt-rs"

echo "Building the WebAssembly module (this takes a few minutes)"
rustup target add wasm32-unknown-unknown
(cd "$WORK/rvt-rs" && cargo build -p rvt-wasm --release --target wasm32-unknown-unknown --locked)

# wasm-bindgen's command-line tool must match the library version the crate was built with.
BINDGEN="$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/[^0-9.]/, "", $3); print $3; exit }' "$WORK/rvt-rs/Cargo.lock")"
echo "Installing wasm-bindgen-cli $BINDGEN"
cargo install wasm-bindgen-cli --version "$BINDGEN" --locked --root "$WORK/tools"

"$WORK/tools/bin/wasm-bindgen" --target web --out-dir "$WORK/out" --out-name rvt \
  "$WORK/rvt-rs/target/wasm32-unknown-unknown/release/rvt_wasm.wasm"

cp "$WORK/out/rvt.js" "$WORK/out/rvt_bg.wasm" "$ROOT/public/rvt/"
cp "$WORK/rvt-rs/LICENSE" "$ROOT/public/rvt/LICENSE"
cp "$WORK/rvt-rs/NOTICE" "$ROOT/public/rvt/NOTICE"
{
  echo "Rust crates statically linked into rvt_bg.wasm (rvt-rs $TAG, wasm32-unknown-unknown)."
  echo "Generated with: cargo tree -p rvt-wasm --target wasm32-unknown-unknown --edges normal --locked"
  echo "Format: crate version | SPDX licence expression"
  echo
  (cd "$WORK/rvt-rs" && cargo tree -p rvt-wasm --target wasm32-unknown-unknown --edges normal --prefix none --format "{p} | {l}" --locked \
    | sed -E 's/ \(\*\)$//; s/ \([^)]*\) \|/ |/' | sort -u)
} > "$ROOT/public/rvt/THIRD-PARTY-CRATES.txt"

echo "Done. public/rvt/ now holds rvt-rs $TAG:"
shasum -a 256 "$ROOT/public/rvt/rvt_bg.wasm" 2>/dev/null || sha256sum "$ROOT/public/rvt/rvt_bg.wasm"
echo "Update the version and checksum in public/rvt/README.md, then test the RVT viewer."
