# sqlite-deno

> **A true-Deno SQLite, WASM-based, with zero compromises to Deno's permission model.** No FFI, no
> network, no native modules, no runtime downloads. One artifact runs everywhere Deno runs,
> including Deno Deploy and the edge.

`sqlite-deno` runs the SQLite team's official WebAssembly build behind a pure-TypeScript VFS that
maps SQLite's file I/O onto Deno's filesystem API. The point is a SQLite that stays inside Deno's
permission model — `--allow-read=./db.sqlite` is the read grant, no `--allow-ffi`, no escape hatch —
while still offering WAL and crash-recovery, and shipping the exact official wasm you can verify
byte-for-byte.

There are already several good SQLite options for Deno, each a sensible choice for a different
problem (see [which to choose](#choosing-a-sqlite-for-deno)). The combination none offers in one
package is **permission-respecting, WAL-capable, and able to run everywhere Deno runs** — the gap
this fills. It is not trying to replace anything that already works.

> **Status: v0.1.0 — Phases 1–9 complete.** The public API has landed and is proven against the full
> L1–L5 crash/concurrency/fuzz suite; the shipped wasm is the official artifact, provenance-verified
> byte-for-byte. The honest limitations are stated plainly in
> [the capability envelope](#the-capability-envelope-the-honest-asterisks) — please read it before
> you commit to the package. Multi-process WAL is [v2](#roadmap).

---

## Quickstart

```typescript
// quickstart.ts
import { openDatabase } from "@ul0gic/sqlite-deno";

// `using` disposes the database at scope end: open statements are finalized,
// the file handle is closed. Default mode is rollback, durable-by-default.
using db = await openDatabase("./app.db");

db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);`);

using insert = db.prepare("INSERT INTO users (name) VALUES (?)");
insert.run("Ada");
insert.run("Grace");

interface User {
  id: number;
  name: string;
}
using byName = db.prepare<User>("SELECT id, name FROM users WHERE name = ?");
const ada = byName.get("Ada"); // User | undefined — inferred, no cast
console.log(ada); // { id: 1, name: "Ada" }
```

```bash
# durable writes need the directory, not just the file (see the durability caveat below)
deno run --allow-read=. --allow-write=. quickstart.ts
# { id: 1, name: "Ada" }
```

That is the whole grant: no `--allow-ffi`, no `--allow-net`, no `--allow-env`. Install via JSR:

```bash
deno add jsr:@ul0gic/sqlite-deno
```

For deeper coverage of the VFS, the lock ladder, the WAL flow, and the crash/durability model, see
[ARCHITECTURE.md](./ARCHITECTURE.md).

---

## The permission story

This is the part the project cares most about getting right. The wasm has **no ambient authority**.
All of SQLite's I/O flows back out through our VFS callbacks, and those reach the filesystem only
through path-scoped `Deno.*Sync` calls. The module cannot open a file the host did not hand it. If
this package were supply-chain-compromised tomorrow, its blast radius would still be **exactly** the
paths you granted — no FFI to abuse, no network to phone home, no ambient filesystem.

```bash
# read access to the directory holding the database - nothing wider
deno run --allow-read=./data your_program.ts
```

The grant is scoped to the database's **parent directory**, not the file alone, because the VFS
canonicalizes paths before touching them (the symlink guard below) and a crash-safe commit fsyncs
the directory — both of which read the directory path. A file-only grant still works for the
plainest read path but **fails closed with a typed error** the moment it must canonicalize or
directory-fsync; it never silently downgrades and never widens what you granted.

### The durability caveat (read this)

The headline "`--allow-read=./app.db` is the entire grant" is true for **reading**. It is **not**
the whole story for **durable writes**: a crash-safe commit requires SQLite to `fsync` the
**directory** containing the database (so a journal's deletion or a file's creation survives a power
cut), and opening a directory handle to fsync it is a _read of the directory path_, which a
file-only grant does not cover. So durable operation needs a read **and** write grant on the
**parent directory**:

```bash
# durable writes: grant the directory, not just the file
deno run --allow-read=./data --allow-write=./data your_program.ts
```

Under a file-only grant the package still works and fails closed — it surfaces a typed error, never
a silent durability downgrade.

### The symlink guard

Deno's permission check is **lexical** — it checks the path you pass, not the canonical target — so
a symlink _inside_ your grant pointing _outside_ it is followed by Deno. The VFS closes this in
userland: before any filesystem op it canonicalizes the path and re-checks the **canonical** target
against Deno's own grant via `Deno.permissions.querySync` (a query, never a request — it can only
refuse, never widen). An out-of-grant target refuses with a typed `SqliteCantOpenError`, zero files
touched outside the grant. The mechanism and the one residual TOCTOU window (Low, closed by the v2
byte-range work) are in [ARCHITECTURE.md](./ARCHITECTURE.md#the-symlink-escape-guard-dec-011).

---

## The capability envelope (the honest asterisks)

These are the limitations, up front, each with the reason. If any rules the package out for your use
case, that is genuinely useful to know early. The full engineering reasoning is in
[ARCHITECTURE.md](./ARCHITECTURE.md).

### Mode 1 (rollback, default), multi-process: **serialized**

One accessor at a time. **No concurrent readers** — a reader excludes other readers _and_ writers
for as long as it holds the file.

**Why:** Deno's userland exposes only whole-file `flock`, not byte-range `fcntl`. The "many readers
XOR one writer" design is verified-unsafe on whole-file `flock` (a failed `LOCK_SH → LOCK_EX`
upgrade silently drops the shared lock, and SQLite's stale-cache revalidation doesn't fire on the
retry path — a rare silent-corruption window). So v1 ships SQLite's own `unix-flock` protocol,
provably correct by construction, at the cost of serialization. True concurrent readers need
byte-range `fcntl` and are [v2](#roadmap).

A contending caller gets a `SqliteBusyError`. A `busyTimeout` open option (ms) lets SQLite
block-and-retry instead; it covers `openDatabase` on POSIX, but on Windows (mandatory locks) a
multi-process caller must wrap `openDatabase` in a `SqliteBusyError` retry loop. A non-zero timeout
is not a guarantee, so keep a caller-side retry loop as the backstop.

### Mode 2 (WAL): **single-process exclusive only**

Real WAL, with the wal-index in heap. **No `-shm` file, no shared-memory methods.** One process owns
the file exclusively.

**Why:** multi-process WAL needs a memory-mapped `-shm` wal-index _and_ byte-range `fcntl`, neither
available from Deno userland today. Exclusive-locking mode runs WAL with the index in heap, needing
only the whole-file exclusive lock Deno already has — exactly what the official `sqlite-wasm` does,
and it covers the dominant Deno shape: one long-running server owning its database. Multi-process
WAL is [v2](#roadmap). Setting `journal_mode=WAL` without `locking_mode=EXCLUSIVE` first **fails
closed** (SQLite returns `"delete"`: no WAL, no crash, no corruption).

### Durability

**Commit durability is separate from integrity.** Every mode and every durability level stays
corruption-free across modeled power loss — `PRAGMA integrity_check` is always `ok`. What varies is
whether the _latest committed_ transaction survives a power cut, set by the `durability` option:

| Mode (option)        | Default `durability` | What the default means                                                                                |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `rollback` (default) | `"full"`             | Durable-by-default: the last committed txn survives modeled power loss. `synchronous=FULL`.           |
| `wal`                | `"normal"`           | SQLite-recommended WAL default: consistency-safe, but the last commit(s) may roll back on power loss. |

- Pass `{ durability: "normal" }` on rollback for a faster opt-in (one fewer sync per commit); it
  stays consistency-safe but the latest commit can be lost on a power cut. Pass
  `{ mode: "wal", durability: "full" }` for power-loss durability in WAL. WAL at the default
  `synchronous=NORMAL` is documented SQLite behavior, not a corruption bug — a `COMMIT` can roll
  back after a power cut (it survives an _application_ crash, just not a _power_ loss).
- **Durability is verified on Linux only.** Directory-fsync durability is crash-proven on Linux for
  both modes. Windows fsync semantics are unverified (the directory fsync is a documented no-op
  there, mirroring SQLite's `os_win.c`); NFS and other networked filesystems are unsupported, as in
  native SQLite. The crash proofs are model-bounded — a worst-legal-device power-loss model plus
  `strace`-verified primitives, not real-hardware power-cut testing.

---

## Verify the artifact yourself

The shipped wasm is the SQLite team's official `@sqlite.org/sqlite-wasm` build, vendored in-package
and pinned to an exact version. You do not have to take that on faith — one command transiently
re-fetches the pinned official tarball, checks its shasum, and byte-compares it to the committed
bytes:

```bash
# yes/no provenance check - the only network access is this transient re-fetch
bash build/verify-build.sh
# RESULT: AUTHENTIC ✓
```

We ship the official artifact rather than a self-compile so that trust anchors to the bytes the
world already runs, not to our toolchain being honest. The pin and the reasoning are in
[WASM_VENDOR.md](./WASM_VENDOR.md); the package itself never fetches anything at install or runtime.

---

## What's proven, and how to check it

The correctness claims are meant to be executable, and they run on the vendored wasm, the real VFS,
and the shipped public API — never a stubbed SQLite. From a clean checkout:

```bash
deno task check        # fmt, lint, type-check, type-aware lint, and the full test suite
deno task test:soak    # Mode 1: N real OS processes, Jepsen bank, CPU-oversubscribed (env-gated)
deno task test:soak:wal # Mode 2: multi-seed WAL crash sweep (env-gated)
```

The suite covers crash/power-loss recovery (a fault-injection VFS reconstructs the disk at every
crash point and reopens through the real VFS, with a negative control that proves the harness can
fail), Mode 1 multi-process concurrency (a Jepsen-style bank workload with SIGKILL crash-recovery),
and Mode 2 WAL crash recovery (torn-tail and crash-during-checkpoint). The methodology is in
[ARCHITECTURE.md](./ARCHITECTURE.md#the-crash-and-durability-model-dec-007-dec-008).

---

## Choosing a SQLite for Deno

Several good options exist, and for many projects one of them is the better fit. An honest signpost:

- **Need maximum write throughput, and `--allow-ffi` is acceptable?** Reach for
  [`@db/sqlite`](https://jsr.io/@db/sqlite) (native, via FFI) — the fastest option.
- **Happy on Deno's built-in, native engine?** `node:sqlite` ships with Deno and needs no
  dependency.
- **Want the smallest WASM footprint for simple, single-process use?**
  [`dyedgreen/deno-sqlite`](https://github.com/dyedgreen/deno-sqlite) is a long-standing, well-loved
  choice.
- **Embedding SQLite in the browser or over OPFS?** The official
  [`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm/) is built for exactly that.

`sqlite-deno` fills one gap none of those cover together: SQLite that **keeps Deno's permission
model fully intact (no FFI), offers WAL, and runs everywhere Deno runs** — including Deno Deploy and
the edge — with the official wasm shipped in-package and verifiable byte-for-byte. If that
combination is what you need, this is for you. If it isn't, one of the above probably serves you
better — and that is a good outcome.

---

## Roadmap

**v1 (current).** Public API, both concurrency modes, crash/durability proofs on Linux, and the
provenance-verified official wasm are all done. Mode selection is constrained at open so a caller
cannot accidentally leave the tested envelope (`{ readonly: true, mode: "wal" }` is rejected). No
user-defined SQL functions in v1 — that JS-callback-reentrancy surface waits until its reentrancy
model is tested.

**v2 — multi-process WAL.** Gated on contributing byte-range `fcntl(F_OFD_SETLK)` locking (and
`mmap` for a real `-shm`) to Deno core. With those, Mode 1 gains the faithful three-byte-range
ladder (true concurrent readers) and WAL goes multi-process. The hope is that this turns into a
focused, useful contribution upstream to Deno itself — help on that front is very welcome.

---

## Contributing

Contributions, issues, questions, and code review are all genuinely welcome — this is built in
public partly so others can poke at it. Whether you want to fix a bug, add a proof to the harness,
improve the docs, or ask how something works, please jump in. **See
[CONTRIBUTING.md](./CONTRIBUTING.md)** for the full guide. The gate every change keeps green:

```bash
deno task check         # fmt --check, lint, type-check, type-aware lint, test
deno task test:soak     # Mode 1 multi-process soak (SQLITE_DENO_SOAK=1, CPU-oversubscribed)
deno task test:soak:wal # Mode 2 WAL crash-sweep soak
```

Two principles guide the project — they exist to keep it trustworthy, not to gatekeep:

- **A database must not lose your data.** No concurrency or durability mode is exposed until its
  crash/concurrency harness is green, including a negative control that proves the harness can catch
  corruption. Adding new proofs here is one of the most valuable things you can contribute.
- **The permission model stays intact.** No change may require a grant beyond `--allow-read` /
  `--allow-write` on the target database, and no code path acquires a permission the caller did not
  pass in. No FFI, no network, no ambient filesystem.

The toolchain is entirely Deno's built-ins (`deno check` / `lint` / `fmt` / `test` / `bench`) plus a
pinned, checksum-verified Biome for type-aware lint (dev/CI only, never shipped). Security policy
and vulnerability reporting are in [SECURITY.md](./SECURITY.md).

---

## License

[MIT](./LICENSE) © 2026 ul0gic
