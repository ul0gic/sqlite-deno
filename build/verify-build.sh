#!/usr/bin/env bash
# Provenance check for the vendored official SQLite wasm (DEC-012).
#
# Anyone — a stranger, an auditor, CI — runs this one command and gets a
# yes/no: are the committed src/wasm/sqlite3.{wasm,mjs} the exact bytes of the
# pinned official @sqlite.org/sqlite-wasm release? It transiently re-fetches the
# pinned npm tarball, verifies its shasum, and byte-compares to the committed
# files. The fetch is the ONLY network access and happens only here — never at
# install or runtime.
#
# Scoped permissions: read the npm registry over the network, read the repo to
# compare the committed bytes. Nothing wider; no --allow-ffi, no --allow-write.
#
# Exit 0 = authentic. Non-zero = mismatch (the typed error prints the reason).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

echo "Verifying vendored SQLite wasm against the pinned official release…"
if deno run \
  --allow-net=registry.npmjs.org \
  --allow-read="$root" \
  "$root/build/verify-vendor.ts"; then
  echo "RESULT: AUTHENTIC ✓"
  exit 0
else
  echo "RESULT: NOT VERIFIED ✗" >&2
  exit 1
fi
