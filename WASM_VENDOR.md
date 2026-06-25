# Vendored SQLite WASM artifact

> **We ship the exact official `@sqlite.org/sqlite-wasm`, vendored in-package, pinned and verifiable
> byte-for-byte.** No runtime download, no first-run fetch, and no self-compile. Trust anchors to
> the SQLite team's signed release, the bytes the world already runs.

`src/wasm/sqlite3.wasm` and `src/wasm/sqlite3.mjs` are committed, third-party build outputs from the
SQLite team's official `@sqlite.org/sqlite-wasm` npm package. They are not edited by hand. The only
hand-written code in the directory is the minimal type augment for the Emscripten init entry point
and the typed re-export the rest of the package imports.

`sqlite3.mjs` is the upstream `dist/index.mjs` (the bundler/browser ESM variant), renamed.
`dist/node.mjs` was deliberately **not** vendored: it imports `node:module`, `node:fs`, and
`node:crypto` and uses `process`, which violates the no-Node-baggage constraint. `index.mjs` carries
zero `node:` imports and probes browser globals only through optional chaining, so under Deno it
instantiates cleanly when handed the wasm bytes directly.

## Why the official artifact, not a self-compile

The package's supply-chain pitch is "trust the artifact, end to end." We achieve it by shipping the
SQLite team's official build, not by recompiling our own and asking you to trust that our toolchain
was honest:

- **Trust anchor.** Verifying against the official, signed release anchors trust to the bytes
  everyone else runs. A self-compile would anchor it to _our_ build pipeline instead.
- **Trust surface.** Self-building doesn't shrink the surface, it _swaps_ it, removing SQLite's
  tightly-controlled `ext/wasm` build and adding the entire emscripten / LLVM / binaryen stack to
  pin and trust.
- **Divergence.** A self-compile ships bytes nobody else runs. No compile-time option this package
  needs is missing from the official build, so there is no reason to.

The whole package (`oo1`, `capi`, `installVfs`) runs on the official build's stock feature set.

## The pin

`build/sqlite-version` is the machine-readable pin, read by the verifier. This table mirrors it:

| Field                  | Value                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| npm package            | `@sqlite.org/sqlite-wasm`                                          |
| version                | `3.53.0-build1`                                                    |
| SQLite library version | `3.53.0`                                                           |
| npm tarball shasum     | `066cab9189973c39edbb7078c55bb4daa1cd2d30` (SHA-1)                 |
| `sqlite3.wasm` sha256  | `02d7e48164395fa68f81c6ec33e9da5461be397dc57602ac0cd89b4bbba1d312` |
| `sqlite3.mjs` sha256   | `f80870f0fa03a39a3338d17ed3fbea04808d344c88e724d90d5f37b9b7b83154` |

The version is pinned **exact**, never "latest." A bump must update the committed bytes in
`src/wasm/`, this table, and `build/sqlite-version` together, and re-run the full gate plus the
crash / concurrency / fuzz suite against the new bytes before publish.

## Verify it yourself

Authenticity is executable. One command transiently re-fetches the pinned npm tarball, checks its
shasum, extracts, and byte-compares `sqlite3.{wasm,mjs}` to the committed copies:

```bash
# yes/no provenance check - a stranger, an auditor, or CI runs this
bash build/verify-build.sh
# RESULT: AUTHENTIC ✓
```

The fetch is the **only** network access and happens only here, scoped to `registry.npmjs.org`. The
package itself never fetches anything at install or runtime; `deno.json` and `deno.lock` carry no
npm specifier, and the glue is imported by relative path. A mismatch on either the tarball shasum or
the per-file byte comparison fails the check with a typed `ProvenanceError` naming the reason.
