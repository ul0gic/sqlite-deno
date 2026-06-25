# sqlite-deno

[![JSR](https://jsr.io/badges/@ul0gic/sqlite-deno)](https://jsr.io/@ul0gic/sqlite-deno)
[![JSR Score](https://jsr.io/badges/@ul0gic/sqlite-deno/score)](https://jsr.io/@ul0gic/sqlite-deno)
[![CI](https://github.com/ul0gic/sqlite-deno/actions/workflows/ci.yml/badge.svg)](https://github.com/ul0gic/sqlite-deno/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/ul0gic/sqlite-deno/badge)](https://securityscorecards.dev/viewer/?uri=github.com/ul0gic/sqlite-deno)

> **SQLite for Deno that keeps your permission model intact.** `--allow-read=./db.sqlite` is the
> whole grant: no FFI, no native modules, no runtime downloads. Runs everywhere Deno runs, including
> Deno Deploy.

The official SQLite WebAssembly build behind a pure-TypeScript VFS, with WAL and crash recovery, and
the exact official wasm you can verify byte-for-byte. WAL is single-process in v1; the honest limits
are in [the capability envelope](#the-capability-envelope-the-honest-asterisks).

---

## Quickstart

Install:

```bash
deno add jsr:@ul0gic/sqlite-deno
```

```typescript
// quickstart.ts
import { openDatabase } from "@ul0gic/sqlite-deno";

// `using` disposes the database at scope end: open statements are finalized
// and the file handle closed. Default mode is rollback, durable by default.
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
const ada = byName.get("Ada"); // User | undefined, inferred (no cast)
console.log(ada); // { id: 1, name: "Ada" }
```

Run it:

```bash
# durable writes need the directory, not just the file (see the permission story below)
deno run --allow-read=. --allow-write=. quickstart.ts
# { id: 1, name: "Ada" }
```

That is the whole grant: no `--allow-ffi`, no `--allow-net`, no `--allow-env`.

For the VFS, the lock ladder, the WAL flow, and the crash/durability model, see
[ARCHITECTURE.md](./ARCHITECTURE.md).

---

## The permission story

The wasm has **no ambient authority.** All of SQLite's I/O flows out through the VFS callbacks,
which reach the filesystem only through path-scoped `Deno.*Sync` calls, so the module cannot open a
file you did not grant. Supply-chain-compromise the package tomorrow and its blast radius is still
**exactly the paths you granted:** no FFI to abuse, no network to phone home, no ambient filesystem.

```bash
deno run --allow-read=./data app.ts                       # read-only
deno run --allow-read=./data --allow-write=./data app.ts  # durable writes
```

- **Grant the parent directory, not just the file.** Canonicalizing paths and `fsync`ing the
  directory on a crash-safe commit both read the directory path, so `./app.db` alone is not enough
  for durable writes.
- **A file-only grant fails closed, never silently.** It works for plain reads, but the moment it
  must canonicalize or directory-fsync it surfaces a typed error. It never downgrades durability
  quietly or widens what you granted.
- **Symlinks cannot escape.** Deno's permission check is lexical, so a link inside your grant aimed
  outside would be followed. The VFS canonicalizes and re-checks the real target against your grant
  (`Deno.permissions.querySync`, a query that can only refuse), rejecting an out-of-grant target
  with a typed `SqliteCantOpenError`. Mechanism and the one residual TOCTOU window (Low, closed by
  v2): [ARCHITECTURE.md](./ARCHITECTURE.md#the-symlink-escape-guard-dec-011).

---

## The capability envelope (the honest asterisks)

These are the limitations, up front, each with the reason. If any rules the package out for your use
case, that is genuinely useful to know early. The full engineering reasoning is in
[ARCHITECTURE.md](./ARCHITECTURE.md).

### Mode 1 (rollback, default), multi-process: **serialized**

One accessor at a time. **No concurrent readers:** a reader excludes other readers and writers while
it holds the file.

**Why:** Deno's userland exposes only whole-file `flock`, not byte-range `fcntl`, and the "many
readers XOR one writer" design is verified-unsafe on whole-file `flock` (a failed
`LOCK_SH → LOCK_EX` upgrade silently drops the shared lock). So v1 ships SQLite's own `unix-flock`
protocol: provably correct by construction, at the cost of serialization. True concurrent readers
need byte-range `fcntl`, which is [v2](#roadmap).

A contending caller gets a `SqliteBusyError`. The `busyTimeout` open option (ms) makes SQLite
block-and-retry on POSIX; on Windows (mandatory locks) wrap `openDatabase` in a `SqliteBusyError`
retry loop. A timeout is not a guarantee, so keep your own retry loop as the backstop.

### Mode 2 (WAL): **single-process exclusive only**

Real WAL, with the wal-index in heap. **No `-shm` file, no shared-memory methods.** One process owns
the file exclusively.

**Why:** multi-process WAL needs a memory-mapped `-shm` wal-index and byte-range `fcntl`, neither
available from Deno userland today. Exclusive-locking mode keeps the index in heap and needs only
the whole-file exclusive lock Deno already has, which is exactly what the official `sqlite-wasm`
does. It covers the dominant Deno shape: one long-running server owning its database. Setting
`journal_mode=WAL` without `locking_mode=EXCLUSIVE` first **fails closed** (SQLite returns
`"delete"`: no WAL, no crash, no corruption). Multi-process WAL is [v2](#roadmap).

### Durability

**Commit durability is separate from integrity.** Every mode and durability level stays
corruption-free across modeled power loss (`PRAGMA integrity_check` is always `ok`). What varies is
whether the _latest committed_ transaction survives a power cut, set by the `durability` option:

| Mode (option)        | Default `durability` | What the default means                                                                                |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `rollback` (default) | `"full"`             | Durable-by-default: the last committed txn survives modeled power loss. `synchronous=FULL`.           |
| `wal`                | `"normal"`           | SQLite-recommended WAL default: consistency-safe, but the last commit(s) may roll back on power loss. |

- Pass `{ durability: "normal" }` on rollback for one fewer sync per commit: still consistency-safe,
  but the latest commit can be lost on a power cut. Pass `{ mode: "wal", durability: "full" }` for
  power-loss durability in WAL. WAL at the default `synchronous=NORMAL` is documented SQLite
  behavior, not a corruption bug: a `COMMIT` can roll back after a power cut (it survives an
  _application_ crash, just not a _power_ loss).
- **Durability is verified on Linux only.** Directory-fsync durability is crash-proven on Linux for
  both modes. Windows fsync semantics are unverified (the directory fsync is a documented no-op
  there, mirroring SQLite's `os_win.c`); NFS and other networked filesystems are unsupported, as in
  native SQLite. The crash proofs are model-bounded: a worst-legal-device power-loss model plus
  `strace`-verified primitives, not real-hardware power-cut testing.

---

## Verify the artifact yourself

The shipped wasm is the SQLite team's official `@sqlite.org/sqlite-wasm` build, vendored in-package
and pinned to an exact version. You do not have to take that on faith. One command transiently
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

The correctness claims are executable. They run on the vendored wasm, the real VFS, and the shipped
public API, never a stubbed SQLite. From a clean checkout:

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
  [`@db/sqlite`](https://jsr.io/@db/sqlite) (native, via FFI). It's the fastest option.
- **Happy on Deno's built-in, native engine?** `node:sqlite` ships with Deno and needs no
  dependency.
- **Want the smallest WASM footprint for simple, single-process use?**
  [`dyedgreen/deno-sqlite`](https://github.com/dyedgreen/deno-sqlite) is a long-standing, well-loved
  choice.
- **Embedding SQLite in the browser or over OPFS?** The official
  [`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm/) is built for exactly that.

`sqlite-deno` fills one gap none of those cover together: SQLite that **keeps Deno's permission
model fully intact (no FFI), offers WAL, and runs everywhere Deno runs** (including Deno Deploy and
the edge), with the official wasm shipped in-package and verifiable byte-for-byte. If that
combination is what you need, this is for you. If not, one of the above probably serves you better,
and that is a good outcome.

---

## Roadmap

**v1 (current).** Public API, both concurrency modes, crash/durability proofs on Linux, and the
provenance-verified official wasm are all done. Mode selection is constrained at open so a caller
cannot accidentally leave the tested envelope (`{ readonly: true, mode: "wal" }` is rejected). No
user-defined SQL functions in v1: that JS-callback-reentrancy surface waits until its reentrancy
model is tested.

**v2: multi-process WAL.** Gated on contributing byte-range `fcntl(F_OFD_SETLK)` locking (and `mmap`
for a real `-shm`) to Deno core. With those, Mode 1 gains the faithful three-byte-range ladder (true
concurrent readers) and WAL goes multi-process. The hope is a focused, useful contribution upstream
to Deno itself; help on that front is very welcome.

---

## Contributing

Contributions, issues, questions, and code review are all genuinely welcome; this is built in public
partly so others can poke at it. Whether you want to fix a bug, add a proof to the harness, improve
the docs, or ask how something works, please jump in. **See [CONTRIBUTING.md](./CONTRIBUTING.md)**
for the full guide. The gate every change keeps green:

```bash
deno task check         # fmt --check, lint, type-check, type-aware lint, test
deno task test:soak     # Mode 1 multi-process soak (SQLITE_DENO_SOAK=1, CPU-oversubscribed)
deno task test:soak:wal # Mode 2 WAL crash-sweep soak
```

Two principles guide the project; they exist to keep it trustworthy, not to gatekeep:

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
