# In-browser Revit reader (vendored)

These files let the RVT viewer read Revit files on the user's own computer,
without uploading them.

| File | What it is |
| --- | --- |
| `rvt_bg.wasm` | [rvt-rs](https://github.com/DrunkOnJava/rvt-rs) compiled to WebAssembly |
| `rvt.js` | The JavaScript bindings generated for it by wasm-bindgen |
| `rvt.worker.js` | This app's worker: reads a file with rvt-rs and returns IFC4 (written for this project) |
| `LICENSE`, `NOTICE` | rvt-rs's licence (Apache-2.0) and notices, unchanged |
| `THIRD-PARTY-CRATES.txt` | The Rust crates linked into the module, with their licences |

## Provenance

- Source: `https://github.com/DrunkOnJava/rvt-rs`, tag `v0.17.0` (commit `495b212c63026269ed7c0d39fd996e645f5250a0`, released 2026-11-09), crate `rvt-wasm`
- Built with `cargo build -p rvt-wasm --release --target wasm32-unknown-unknown --locked` (Rust 1.97.0) and `wasm-bindgen 0.2.118 --target web --out-name rvt`
- `rvt_bg.wasm` sha256: `931656d4c7fdf45dc1e6a610a3740bc992ae822d106817ca1e7532a48fed1689`
- No changes were made to the rvt-rs source.
- A rebuild gives the same `rvt.js`. The `.wasm` differs by a few bytes, because the folder it was built in is recorded in its error messages, so its checksum is not reproducible across machines.

To rebuild, or to move to a newer rvt-rs release, run `npm run build:rvt-wasm`
from the project root (see `scripts/build-rvt-wasm.sh`).

## What to expect

rvt-rs is an independent, clean-room reader. It is not Autodesk software and is
not affiliated with Autodesk. It recovers part of a project: many shapes are
simplified, some elements are drawn only as bounding boxes, some are left out,
and parameters are incomplete. Its own support matrix rates Revit 2023 to 2025
projects as "partial" and other releases as "experimental". Every file opened
in the app gets a report, taken from rvt-rs's diagnostics, of what was
recovered. For exact geometry use the Autodesk cloud engine in the same panel.

"Autodesk" and "Revit" are registered trademarks of Autodesk, Inc.
