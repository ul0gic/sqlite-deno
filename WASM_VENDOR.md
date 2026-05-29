# Vendored SQLite WASM artifact

`sqlite3.wasm` and `sqlite3.mjs` are committed, third-party build outputs from the SQLite team's
official `@sqlite.org/sqlite-wasm`. They are not edited by hand. The only hand-written code in this
directory is `sqlite3.d.ts` (a minimal type augment for the Emscripten init entry point, which the
upstream `.d.mts` does not model) and `mod.ts` (the typed re-export the rest of the package
imports).

## Pin

| Field                  | Value                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| npm package            | `@sqlite.org/sqlite-wasm`                                          |
| version                | `3.53.0-build1`                                                    |
| SQLite library version | `3.53.0`                                                           |
| npm tarball shasum     | `066cab9189973c39edbb7078c55bb4daa1cd2d30`                         |
| `sqlite3.wasm` sha256  | `02d7e48164395fa68f81c6ec33e9da5461be397dc57602ac0cd89b4bbba1d312` |
| `sqlite3.mjs` sha256   | `f80870f0fa03a39a3338d17ed3fbea04808d344c88e724d90d5f37b9b7b83154` |

`sqlite3.mjs` is the upstream `dist/index.mjs` (the bundler/browser ESM variant), renamed.
`dist/node.mjs` was deliberately **not** vendored: it imports `node:module`, `node:fs`, and
`node:crypto` and uses `process`, which violates the no-Node-baggage constraint. `index.mjs` carries
zero `node:` imports and probes browser globals only through optional chaining, so under Deno it
instantiates cleanly when handed the wasm bytes directly via `wasmBinary`.

## How it was vendored

```sh
npm pack @sqlite.org/sqlite-wasm   # transient; produces the .tgz
tar xzf sqlite.org-sqlite-wasm-3.53.0-build1.tgz
cp package/dist/index.mjs   src/wasm/sqlite3.mjs
cp package/dist/sqlite3.wasm src/wasm/sqlite3.wasm
```

The npm package is fetched transiently only to extract these two bytes-for-bytes files. There is
**no** npm specifier in `deno.json` or `deno.lock`; the package imports the glue by relative path.
The end state has zero npm dependencies.

The byte-identical reproducible in-package build (compiling our own wasm from the pinned
amalgamation) is a separate, gated effort — see Phase 9 of the build plan. Until then, the published
artifact's provenance is the npm tarball shasum above.
