# sqlite-deno

> **A true-Deno SQLite, WASM-based, with zero compromises to Deno's permission model.** No FFI. No
> network. No native modules. No runtime downloads. The same single artifact runs everywhere Deno
> runs, including Deno Deploy and the edge.

This is a **build-in-public** repository. The engine, a pure-TypeScript Deno-filesystem VFS over the
SQLite team's official WebAssembly build, with two concurrency modes and crash recovery, is built
and tested against a deterministic crash/concurrency harness. The **public API has landed** —
`openDatabase`, `Database`, typed `Statement<Row>`, transactions — and as of Phase 8 the **full
L1–L5 test suite** drives that shipped surface (functional, permission, crash/durability,
concurrency, and fuzz). It is **not yet published to JSR** (that is Phase 10), so you run it from a
checkout, not an install. Please read the status section before anything else, so you know exactly
what works today.

---

## Status: tested & proven (Phase 8), not yet published

**Phase 8 of 10 complete.** You can `import` from [`src/mod.ts`](./src/mod.ts) and drive a real,
typed `openDatabase` / `Database` / `Statement<Row>` surface, and the full L1–L5 test suite now
proves that shipped surface end to end. What is **not** done is the reproducible byte-identical wasm
build (Phase 9) and the JSR release (Phase 10) — so there is **no `jsr:` install to point at yet**.
The usage below is the real API shape; it runs from a clone.

|                                  |                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Working and tested**           | The public API (`openDatabase`, `Database`, typed `Statement<Row>`, transactions, typed errors). The Deno-filesystem VFS (pure TypeScript, over `Deno.*Sync`). Both concurrency modes. Crash / power-loss recovery, on Linux (model-bounded, see [the caveats](#the-honest-capability-envelope-the-asterisks-each-with-the-why)). |
| **Not built**                    | The reproducible byte-identical wasm build (Phase 9). The JSR release (Phase 10) — not published yet, so no `jsr:` install.                                                                                                                                                                                                       |
| **Vendored, not yet self-built** | The wasm is the official `@sqlite.org/sqlite-wasm` `3.53.0-build1`, committed in-package (see [`WASM_VENDOR.md`](./WASM_VENDOR.md)). Building our own byte-for-byte from pinned source is Phase 9 and is **0% done**.                                                                                                             |

```
v0 - prove the path
  Phase 1  Scaffold & toolchain        ████████████████████  100%  done
  Phase 2  WASM integration spike      ████████████████████  100%  done
  Phase 3  Deno-FS VFS (file-backed)   ████████████████████  100%  done
v1 - public launch
  Phase 4  Crash-sim harness           ████████████████████  100%  done
  Phase 5  Mode 1 - rollback locks     ████████████████████  100%  done
  Phase 6  Mode 2 - WAL (exclusive)    ████████████████████  100%  done
  Phase 7  Public API & bindings       ████████████████████  100%  done
  Phase 8  Full test suite (L1–L5)     ████████████████████  100%  done  (L6 build byte-compare lands with Phase 9)
  Phase 9  Reproducible build & CI     ░░░░░░░░░░░░░░░░░░░░    0%
  Phase 10 JSR publish & docs          ░░░░░░░░░░░░░░░░░░░░    0%
v2 - multi-process WAL                 ░░░░░░░░░░░░░░░░░░░░    0%  (gated on Deno core)
```

### Quickstart

Not on JSR yet, so import from the local source (a `jsr:@scope/sqlite-deno` specifier will arrive
with Phase 10). The grant below is the entire permission footprint for durable writes — read **and**
write on the directory holding the database, nothing else. (Why the directory and not just the file
is the [durability caveat](#the-honest-durability-caveat-read-this).)

```typescript
// quickstart.ts
import { openDatabase } from "./src/mod.ts";

// `using` disposes the database at scope end: open statements are finalized,
// the file handle is closed. Default mode is rollback, durable-by-default.
using db = await openDatabase("./app.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
`);

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

// A transaction is a SAVEPOINT; a `using tx` that throws before commit rolls back.
const tx = db.transaction();
db.exec("UPDATE users SET name = 'Ada Lovelace' WHERE name = 'Ada'");
tx.commit();
```

```bash
# durable writes need the directory, not just the file (see the durability caveat)
deno run --allow-read=. --allow-write=. quickstart.ts
# { id: 1, name: "Ada" }
```

That is the whole grant: no `--allow-ffi`, no `--allow-net`, no `--allow-env`.

### How to read this repo right now

```bash
git clone <this-repo> && cd sqlite-deno
deno task check     # fmt, lint, type-check, and the full proof suite (195 tests)
```

- The public API lives in [`src/mod.ts`](./src/mod.ts) — `openDatabase` and the `Database` /
  `Statement<Row>` / `Transaction` types, plus the typed `SqliteError` hierarchy.
- The engine entry points live in [`src/vfs/`](./src/vfs/); `installDenoVfs` (in
  [`src/vfs/deno.ts`](./src/vfs/deno.ts)) is what registers our VFS against the wasm. `openDatabase`
  installs it for you.
- The proofs are in [`test/`](./test/); the crash and concurrency harnesses under
  [`test/harness/`](./test/harness/) are the most important code in the project, and they now drive
  the **shipped `openDatabase` surface**, not the engine alone.

---

## What it is, and why it exists

There are several good SQLite options for Deno already, and each is a sensible choice for a
different problem. The combination none of them offers in one package is **permission-respecting,
WAL-capable, and able to run everywhere Deno runs**, and that is the niche this project aims to
fill. Each existing option makes a different, reasonable trade-off:

- **FFI options** (`@db/sqlite`) are fast and full-featured. The trade-off is that they require
  `--allow-ffi` (which widens Deno's permission model back toward the Node default), download a
  prebuilt `.so` at first run, and cannot run on Deno Deploy or the edge, because there is no FFI
  there.
- **The existing WASM lineage** (`dyedgreen/deno-sqlite`) respects the permission model and has
  served a lot of projects well. It predates SQLite's official wasm build and does not have WAL,
  file locking, or shared memory.
- **`node:sqlite`**, built into Deno, is a great fit if you want a batteries-included native engine
  with the Node-shaped API. It is a native engine rather than a permission-model-first or edge
  story.

The bet behind this project is a smaller, more specific one: Deno's permission model is most useful
when infrastructure-grade packages can honor it without an escape hatch, and a SQLite that stays
inside the permission model is a worthwhile thing to have for the cases where that matters. That is
the goal, to cover that specific gap well, not to replace anything that already works.

**The permission model is the design constraint everything else serves.**

---

## The permission story

This is the part the project cares most about getting right. The wasm has **no ambient authority**.
All of SQLite's I/O flows back out through our VFS callbacks, and those reach the filesystem only
through path-scoped `Deno.*Sync` calls. The module cannot open a file the host did not hand it. If
this package were supply-chain-compromised tomorrow, its blast radius would still be **exactly** the
paths you granted, no FFI to abuse, no network to phone home, no ambient filesystem.

What the package needs, and nothing more:

```bash
# read access to the directory holding the database - no --allow-ffi, no --allow-net, no --allow-env
deno run --allow-read=./data your_program.ts
```

The grant is scoped to the database's **parent directory**, not the file alone, because the VFS
canonicalizes paths before touching them (the symlink guard below) and a crash-safe commit fsyncs
the directory — both of which read the directory path. A file-only grant still works for the plainest
read path but **fails closed with a typed error** naming the grant it needs the moment it must
canonicalize or directory-fsync; it never silently downgrades and never widens what you granted. The
[durability caveat](#the-honest-durability-caveat-read-this) covers the write side.

### Symlink escape: the guard, and its one residual

Deno's permission check is **lexical** — it checks the path you pass, not the canonical target. So a
symlink that lives *inside* your grant but points *outside* it is followed by Deno (verified on Deno
2.8.1), and naïvely that would let I/O land outside the granted prefix. The VFS closes this in
userland: before any filesystem op it canonicalizes the path with `Deno.realPathSync` (resolving
symlinked directory components, a symlinked final component, and the parent of a path being created)
and re-checks the **canonical** target against Deno's own grant via `Deno.permissions.querySync` — a
query, never a request, so it can only ever refuse, never widen your grant. If the canonical target
isn't granted, the open refuses with a typed `SqliteCantOpenError` and **zero files are created,
read, deleted, or fsynced outside the grant**. This is the canonicalize-then-recheck Deno itself
omits, applied uniformly to all four filesystem doors (open, delete, access, directory-sync).

> **The one residual (honest):** a TOCTOU window exists between canonicalizing the path and opening
> it. Exploiting it requires an attacker who already holds write access *into* the granted directory
> — who can therefore already corrupt the database directly — and it cannot reach outside the grant
> in any way that in-grant write access can't already. Tracked as
> [SEC-002](https://github.com/ul0gic/sqlite-deno/issues/21) (Low); the complete fix is upstream Deno doing the
> canonicalize-before-check itself.

### The honest durability caveat, read this

The headline "`--allow-read=./app.db` is the entire grant" is true for **reading**. It is **not**
the whole story for **durable writes**:

- A crash-safe commit requires SQLite to `fsync` the **directory** that contains the database (so a
  journal's deletion or a file's creation survives a power cut). Opening a directory handle to fsync
  it is a _read of the directory path_, which a **file-only** grant does not cover.
- So **durable** operation needs a read (and write) grant on the **parent directory**:

  ```bash
  # durable writes: grant the directory, not just the file
  deno run --allow-read=./data --allow-write=./data your_program.ts
  ```

- Under a file-only grant the package still works and **fails closed**, it never widens your grant,
  but the directory-fsync is denied, so the last-commit durability guarantee is unavailable. We
  surface this as an error, never as a silent downgrade.

The engine behavior is fail-closed and never grant-widening. The full durability model — what each
commit mode guarantees, and the one knob that trades a sync for speed — is in
[Durability](#durability) below.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Your code  →  public API: openDatabase, Database, Statement │  ← built (Phase 7)
├──────────────────────────────────────────────────────────────┤
│  JS↔WASM glue (src/glue.ts): marshals values, owns memory    │
├──────────────────────────────────────────────────────────────┤
│  Official @sqlite.org/sqlite-wasm 3.53.0 (vendored, pinned)  │  ← the SQLite engine
├──────────────────────────────────────────────────────────────┤
│  Deno-FS VFS (pure TypeScript, src/vfs/*)                    │  ← honors the grant
│     installed at runtime via sqlite3.vfs.installVfs          │
│     I/O → Deno.openSync / readSync / writeSync / tryLockSync │
└──────────────────────────────────────────────────────────────┘
```

The key facts:

- **No recompile.** We register a pure-JS VFS against the _prebuilt_ official wasm via `installVfs`
  , the same mechanism SQLite's own browser OPFS VFS uses. We add **no C**.
- **The VFS is simpler than the browser's.** OPFS is async but SQLite's VFS is synchronous, so the
  browser VFS needs a `SharedArrayBuffer` + `Atomics.wait` async-proxy dance. **Deno's file API is
  already synchronous**, so our VFS calls Deno I/O directly.
- **Runs on Deno Deploy and the edge** by construction, one wasm, every target, no native binaries
  to build, sign, and re-download.

### VFS dispatch

```mermaid
flowchart TD
  C["SQLite C engine (wasm)"]
  IO["src/vfs/io.ts"]
  NS["src/vfs/namespace.ts"]
  LK["src/vfs/lock.ts (Mode 1)"]
  DENO["Deno.*Sync<br/>(read / write / sync / truncate)"]
  FLOCK["Deno FsFile.tryLockSync / unlockSync<br/>(whole-file flock)"]
  FS[("granted paths only")]

  C -->|xOpen xRead xWrite xSync xClose| IO
  C -->|xAccess xFullPathname xDelete| NS
  C -->|xLock xUnlock xCheckReservedLock| LK
  IO --> DENO
  NS --> DENO
  LK --> FLOCK
  DENO --> FS
  FLOCK --> FS

  classDef engine fill:#a8b1ff,stroke:#111,color:#111,stroke-width:1px;
  classDef vfs fill:#70ffaf,stroke:#111,color:#111,stroke-width:1px;
  classDef host fill:#bff7d4,stroke:#111,color:#111,stroke-width:1px;
  classDef disk fill:#ffd479,stroke:#111,color:#111,stroke-width:1px;

  class C engine;
  class IO,NS,LK vfs;
  class DENO,FLOCK host;
  class FS disk;
```

Every VFS callback catches all errors and returns a SQLite result code; a throw across into C is a
bug, never an error path. Colors only group the layers: blue is the SQLite engine, green is our
pure-TypeScript VFS, light green is the Deno host API it calls, and amber is the filesystem boundary
that stays inside the granted paths.

### The lock ladder (Mode 1, as shipped)

SQLite drives a five-state ladder. Native SQLite implements it with **byte-range** locks at three
independent offsets, which is what lets readers coexist. Deno exposes only **whole-file** `flock`,
so v1 collapses the ladder to SQLite's own `unix-flock` protocol: take a whole-file `LOCK_EX` for
the first lock of _any_ level, hold it through the transaction, release it only at `UNLOCKED`. (Why
we did _not_ try to be cleverer is in
[The story](#what-we-ran-into-and-decided-the-engineering-story).)

```mermaid
stateDiagram-v2
  [*] --> UNLOCKED
  UNLOCKED --> SHARED: xLock(SHARED) → tryLockSync(exclusive) takes whole-file LOCK_EX
  SHARED --> RESERVED: xLock(RESERVED) → no syscall (already hold LOCK_EX)
  RESERVED --> PENDING: xLock(PENDING) → no syscall
  PENDING --> EXCLUSIVE: xLock(EXCLUSIVE) → no syscall
  EXCLUSIVE --> SHARED: xUnlock(SHARED) → keep LOCK_EX (like unix-flock)
  SHARED --> UNLOCKED: xUnlock(NONE) → unlockSync()
  note right of SHARED
    OS lock held is only ever {none, exclusive} - never shared.
    No upgrade path exists, so the flock-upgrade hazard cannot occur.
    Consequence: multi-process SERIALIZED - one accessor at a time.
  end note

  classDef unlocked fill:#bff7d4,stroke:#111,color:#111,stroke-width:1px;
  classDef shared fill:#70ffaf,stroke:#111,color:#111,stroke-width:1px;
  classDef exclusive fill:#ffd479,stroke:#111,color:#111,stroke-width:1px;
  class UNLOCKED unlocked
  class SHARED shared
  class RESERVED,PENDING,EXCLUSIVE exclusive
```

### WAL write / checkpoint (Mode 2, single-process exclusive)

```mermaid
sequenceDiagram
  box rgb(168,177,255) app + SQLite engine
    participant App
    participant SQLite as SQLite (wasm)
  end
  box rgb(112,255,175) our VFS
    participant VFS as Deno-FS VFS
  end
  box rgb(255,212,121) files (granted paths)
    participant WAL as -wal file
    participant DB as main db file
  end

  Note over SQLite: PRAGMA locking_mode=EXCLUSIVE *before* journal_mode=WAL<br/>→ wal-index in heap, NO -shm, xShm* never called
  App->>SQLite: COMMIT
  SQLite->>VFS: append commit frame
  VFS->>WAL: writeSync + syncSync (the commit point lives in -wal)
  Note over WAL,DB: commit is the synced commit frame - there is no journal-unlink point
  App->>SQLite: PRAGMA wal_checkpoint(TRUNCATE)
  SQLite->>VFS: read frames, write pages
  VFS->>DB: writeSync committed pages + syncSync
  SQLite->>VFS: truncate -wal
  Note over SQLite: crash recovery rebuilds the heap wal-index by scanning -wal frame headers
```

---

## What's tested, and how to verify it yourself

The correctness claims here are meant to be **executable rather than taken on faith**, please run
them and check. The whole suite runs from a clean checkout:

```bash
deno task check        # fmt --check, lint, type-check, type-aware lint, full test suite - 195 tests
deno task test:soak    # Mode 1: N real OS processes, Jepsen bank, CPU-oversubscribed (env-gated)
deno task test:soak:wal # Mode 2: multi-seed WAL crash sweep (env-gated)
```

The L3 crash, L4 concurrency, and WAL crash-sweep harnesses now drive the **shipped `openDatabase`
surface** — belt-and-suspenders: the engine-floor proofs are retained, and the same harnesses are
re-pointed at the public `Database` / `Statement` / `Transaction` path so a regression in the
bindings is caught by the same crash and concurrency invariants, all negative-control-gated.

What the suite proves:

- **Crash / power-loss recovery (Linux).** A deterministic fault-injection VFS records every write
  and sync, then a power-loss model reconstructs the disk at each crash point (synced data exact;
  unsynced data dropped, applied, or torn at sector granularity) and reopens through the _real_ VFS.
  Invariants checked at every crash point: `integrity_check = ok`, committed transactions present,
  uncommitted absent. A **negative control** (a lying no-op `xSync`) is proven to be _caught_, a
  harness that stays green with durability disabled proves nothing. There is also a real
  `SIGKILL`-mid-write subprocess test.
- **Mode 1 concurrency.** N real OS subprocesses against one shared file, a Jepsen-style bank
  workload (balance-sum conservation, monotonic commit counter, no torn reads, periodic
  `integrity_check`), SIGKILL crash-recovery (exactly one process replays a hot journal), and a
  negative control (no-op locks → corruption detected). Soaked at 36k serialized commits under CPU
  oversubscription.
- **Mode 2 WAL crash recovery.** Crash sweep over the `-wal` op stream: torn-tail recovery to a
  consistent committed prefix, crash-during-checkpoint, salt-advance anti-stale-replay, recovery
  from `{db, -wal}` with the `-shm` deleted (the heap wal-index is rebuilt from frame headers -
  there is no `-shm`). Two negative controls caught.

These run on the **vendored** wasm, the **real** Deno-FS VFS, and the **shipped public API** — never
a stubbed SQLite.

---

## The honest capability envelope (the asterisks, each with the why)

These are the limitations, up front, each with the reason behind it. If any of these rule the
package out for your use case, that is genuinely useful to know before you invest time in it.

### Mode 1, rollback journal, multi-process: **serialized**

One accessor at a time. **No concurrent readers.** A reader excludes other readers _and_ writers for
as long as it holds the file.

**Why:** Deno's userland exposes only whole-file `flock`, not byte-range `fcntl`. The obvious "many
readers XOR one writer" design (shared locks for readers, upgrade to exclusive for a writer) is
**verified-unsafe** on whole-file `flock`: a Linux `flock` upgrade is non-atomic, a failed
`LOCK_SH → LOCK_EX` upgrade _drops_ the shared lock while returning failure, and SQLite's
change-counter revalidation does not fire on the busy-retry path. That is a real (rare)
silent-stale-read / stale-commit corruption window. There is no event-loop-safe way to close it
without byte-range locks. So v1 ships SQLite's own `unix-flock` protocol verbatim (`LOCK_EX` for
every level), which is **provably correct by construction**, at the cost of serialization. True
"many readers XOR one writer" needs byte-range `fcntl` and is **v2**.

> **The multi-process Mode-1 contract:** a contending caller gets a `SqliteBusyError` (the lock is
> held), and the retry is the caller's — wrap the contended `db.transaction()` (and the
> `openDatabase` itself, whose mode pragmas also take the lock) in a retry loop on
> `SqliteBusyError`. All lock calls are non-blocking, so there is no OS deadlock. A `busyTimeout`
> open option that would let SQLite block-and-retry for you — so callers don't hand-roll this — is a
> tracked enhancement ([ENH-005](https://github.com/ul0gic/sqlite-deno/issues/18)); it is **not implemented yet**, so today
> the retry loop is yours.

### Mode 2, WAL: **single-process exclusive only**

Real WAL, with the wal-index in heap. **No `-shm` file, no shared-memory methods.** One process owns
the file exclusively.

**Why:** multi-process WAL needs a memory-mapped `-shm` wal-index _and_ byte-range `fcntl` for
cross-process coordination, neither available from Deno userland today. Exclusive locking mode runs
WAL with the index in heap, which needs only the whole-file exclusive lock Deno already has. This is
exactly what the official `sqlite-wasm` does, and it covers the dominant Deno shape: one
long-running server process owning its database. Multi-process WAL is **v2**.

> Setting `journal_mode=WAL` without `locking_mode=EXCLUSIVE` first **fails closed**, SQLite returns
> `"delete"` (no WAL, no crash, no corruption) because the VFS has no shm.

### Durability

**Commit durability is separate from integrity.** Every mode and every durability level stays
**corruption-free** across the modeled power loss — `PRAGMA integrity_check` is always `ok`. The
only thing that varies is whether the _latest committed_ transaction survives a power cut. That one
axis is the `durability` option, and the two modes default it differently:

| Mode (option)        | Default `durability` | What the default means                                                                                |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `rollback` (default) | **`"full"`**         | Durable-by-default: the last committed txn survives modeled power loss. `synchronous=FULL`.           |
| `wal`                | **`"normal"`**       | SQLite-recommended WAL default: consistency-safe, but the last commit(s) may roll back on power loss. |

- **Rollback defaults `durability: "full"`** (`synchronous=FULL`) — durable-by-default, the last
  committed transaction survives the modeled power loss. Pass `{ durability: "normal" }` for the
  faster opt-in (one fewer journal sync per commit); it stays consistency-safe, but the latest
  commit can be lost on a power cut. This was a real footgun the harness caught — see
  [the engineering story below](#bug-004-re-pointing-the-harness-at-the-public-api-found-a-default-that-silently-dropped-the-last-commit).
- **WAL defaults `durability: "normal"`** (`synchronous=NORMAL`), the SQLite-recommended WAL
  default: consistency-safe, but a transaction that returned `COMMIT` can roll back after a power
  cut (it survives an _application_ crash, just not a _power_ loss). This is documented SQLite
  behavior, not a corruption bug — `integrity_check` stays `ok`. Pass
  `{ mode: "wal", durability: "full" }` for power-loss durability in WAL.
- **Directory-fsync durability is shipped and crash-proven on Linux for both modes** — rollback
  *and* WAL (it makes journal creation/deletion survive a power cut). It needs the
  **parent-directory** grant, see [the permission caveat](#the-honest-durability-caveat-read-this)
  above; under a file-only grant the package fails closed rather than silently dropping the sync.
- **Platform support: Linux only, for the durability claim.** Linux directory-fsync durability is
  crash-proven (rollback + WAL). **Windows** fsync semantics are **unverified** — there is no Windows
  test rig yet, so do not rely on the durability guarantee there. **NFS and other networked
  filesystems are explicitly unsupported**, same as native SQLite.
- The crash proofs are model-bounded (a worst-legal-device power-loss model + Linux
  `strace`-verified primitives), **not** real-hardware power-cut testing. A hardware rig is a later
  release-hardening layer.

---

## What we ran into and decided (the engineering story)

The decisions below are the durable record of _why_ the thing is built the way it is, including the
times the first attempt was wrong. The guiding rule: **no concurrency or durability mode ships until
its harness proves it, for a database, "mostly works" is silent corruption waiting to happen.**
Twice this discipline caught a corruption hole that would otherwise have shipped, and both are
written up below, mistakes included.

### WASM, not FFI, to keep the permission model intact

FFI would be faster and simpler to build. The trade-off is that it requires `--allow-ffi` (which
widens Deno's permission model), downloads a native binary at first run, and does not run on Deno
Deploy. This project takes the other side of that trade: WASM with a VFS, so the engine has **no
ambient authority** and the blast radius is exactly the granted paths. The cost is some write
throughput; the gain is the permission model, the edge, and a verifiable supply chain. That trade is
laid out plainly in the matrix below, including where it loses.

### A pure-TypeScript VFS, no recompile, edge-compatible

Rather than fork an existing lineage or compile our own wasm, the project consumes the official
`@sqlite.org/sqlite-wasm` and registers a VFS against it in pure TypeScript via `installVfs`. v1
carries **no C toolchain**, the package is auditable TypeScript over a pinned wasm blob. We did not
fork `@db/sqlite` (its architecture is FFI-first, a different and valid design) nor the `dyedgreen`
lineage (it predates the official wasm build that makes this VFS approach practical); building fresh
on the official wasm was the cleanest fit for the permission-first goal here.

### The crash harness as a gate, built _before_ locking and WAL

The most load-bearing code in the project is a deterministic crash-simulation VFS, built _before_
any locking or WAL so every later mode can be checked against it. A locking or WAL mode is exposed
only after its crash + concurrency harness is green, including a **negative control** that proves
the harness can actually fail (a harness that stays green with durability disabled would prove
nothing). This is the one rule we hold firmly: a red harness means the mode stays
single-process-only or unshipped, rather than "ship it and watch."

### BUG-001, the crash harness found _silent_ committed-data loss, and the first fix was wrong

The harness found that in DELETE journal mode a committed transaction could be **silently lost**
(`integrity_check` still `ok`!) after a power cut: a "zombie" hot journal reappears and SQLite rolls
the committed pages back. The first diagnosed root cause, _"Deno cannot fsync a directory"_, was
**wrong**. A 30-second `strace` probe showed `Deno.openSync(dir).syncSync()` _is_ a directory fsync
(`openat` + `fsync`); the VFS simply wasn't issuing it. The real fixes: default to
`journal_mode=PERSIST` (durable via file-content fsync, no directory round-trip) **and** issue the
directory fsync in the VFS where SQLite expects it. Both are harness-proven on Linux. The lesson:
verify the root cause against the artifact before designing around it.

### BUG-004, re-pointing the harness at the public API found a default that silently dropped the last commit

The moment the L3 crash harness was re-pointed off the engine floor and onto the shipped
`openDatabase` path, it caught another **silent** committed-data loss. The engine-floor harness had
run SQLite's own `synchronous=FULL` default and stayed green; the public API had shipped the
rollback default at `synchronous=NORMAL`, and at `NORMAL` a torn next-transaction journal can be
resurrected over a prior commit after a power cut — `integrity_check` still `ok`, the last commit
silently gone. The same workload at `FULL` survived with zero losses. The fix: default the rollback
envelope to `synchronous=FULL` (durable-by-default), with `{ durability: "normal" }` kept as an
explicit, documented opt-in. Like BUG-001, the harness earned its keep precisely _because_ a new
code path exercised a window the old one never did — the regression guard now sweeps both levels
explicitly.

### The X-strict pivot, we _retreated_ from an unproven concurrent-reader design

The first Mode-1 draft was the clever "many readers XOR one writer" design. Verifying it against the
pinned SQLite source (`os_unix.c`, `pager.c`) and probing Linux `flock` revealed the
non-atomic-upgrade corruption hazard described above, and that the SQLite revalidation we were
counting on to save us **does not fire** on the relevant path. Rather than ship an unproven
concurrency win, we _retreated_ to the provably-safe serialized design (SQLite's own `unix-flock`
protocol) and deferred concurrent readers to v2. Shipping less, proven, beat shipping more,
unproven.

---

## Honest comparison matrix

A fair read of where this sits among good alternatives. It is slower on raw write throughput, and
trades that for the permission model and edge support. None of the alternatives are strawmen, each
is a reasonable choice, and for many projects the right one.

|                                 | **sqlite-deno** (this)                         | `@db/sqlite` (FFI)                 | `node:sqlite` (built-in)                        | `dyedgreen/deno-sqlite` (WASM)     | `@sqlite.org/sqlite-wasm` (official)  |
| ------------------------------- | ---------------------------------------------- | ---------------------------------- | ----------------------------------------------- | ---------------------------------- | ------------------------------------- |
| Engine                          | WASM (official)                                | native (FFI)                       | native (built into Deno)                        | WASM (own build)                   | WASM (official)                       |
| Permission grant                | `--allow-read`/`-write` only                   | **needs `--allow-ffi`**            | engine is native; not the Deno permission story | `--allow-read`/`-write` only       | read of wasm only (browser-first)     |
| Runtime download                | none (in-package)                              | **downloads a `.so` at first run** | none (in Deno)                                  | none                               | none                                  |
| Runs on Deno Deploy / edge      | **yes**                                        | **no** (no FFI)                    | yes                                             | yes                                | designed for the browser, not Deno FS |
| WAL                             | **yes** (single-process, v1)                   | yes (full)                         | yes (native)                                    | **no**                             | yes (browser/OPFS)                    |
| Multi-process                   | yes, **serialized** (v1); full WAL in v2       | yes (full byte-range)              | yes (native)                                    | yes (rollback, readers-XOR-writer) | n/a (browser)                         |
| Bulk-write throughput           | slower (WASM), **we lose here**                | **fastest**                        | fast (native)                                   | slower (WASM)                      | slower (WASM)                         |
| Reproducible build / provenance | **planned** (Phase 9–10, OIDC), vendored today | binary from a release              | ships with Deno                                 | own build                          | npm-published                         |
| Deno-filesystem VFS             | **yes** (pure TS)                              | n/a (native)                       | n/a (native)                                    | yes                                | no (OPFS-oriented)                    |
| Public API                      | **yes** (`openDatabase`, typed `Statement`)    | yes                                | yes (`node:sqlite`)                             | yes                                | yes (browser `oo1`)                   |
| Published / installable         | **not yet** (Phase 10 JSR; runs from a clone)  | yes (JSR)                          | yes (built into Deno)                           | yes (deno.land/x)                  | yes (npm)                             |

Take-away: if you need maximum bulk-write speed and `--allow-ffi` is acceptable, `@db/sqlite` is an
excellent choice. If what you need is an embedded SQLite that **keeps Deno's permission model intact
and runs on the edge**, that is the gap this project fills — the API is here today; the JSR release
is Phase 10.

---

## Roadmap

**v1 (public launch):**

- **Phase 7, Public API — done.** `openDatabase`, `Database`, typed `Statement<Row>`, transactions,
  `using`/`Symbol.dispose` lifetimes, Web-Streams result streaming. Mode selection is explicit and
  constrained at open (illegal combos unrepresentable — `{ readonly: true, mode: "wal" }` is
  rejected), so a caller cannot accidentally leave the tested engine envelope. No user-defined SQL
  functions in v1 (that JS-callback-reentrancy surface is one place native engines have historically
  hit use-after-free; it waits until the reentrancy model is tested). A `busyTimeout` open
  affordance, so multi-process Mode-1 callers need not hand-roll `SqliteBusyError` retry, is tracked
  ([ENH-005](https://github.com/ul0gic/sqlite-deno/issues/18)) but not yet built.
- **Phase 8, Full L1–L5 test suite — done.** Functional, permission, crash/durability, concurrency,
  and a generative SQL fuzzer, all driving the shipped `openDatabase` surface (the L3/L4/WAL
  harnesses are re-pointed at the public path). L6, the reproducible-build byte-compare, lands with
  Phase 9 because it needs the build pipeline that doesn't exist yet; the borrowed-TCL/`dbsqlfuzz`
  corpus was ruled out of scope, a native C shim would bypass the very wasm artifact under test.
- **Phase 9, Reproducible byte-identical wasm build.** Today the wasm is the **vendored** official
  artifact; compiling our own byte-for-byte from pinned SQLite source + pinned toolchain, with a
  `verify-build.sh` a stranger can run, is **not done**.
- **Phase 10, JSR publish** with OIDC provenance, immutable versions, API reference.

**v2, multi-process WAL.** Gated on contributing byte-range `fcntl(F_OFD_SETLK)` locking to Deno
core (`ext/io/fs.rs`) and exposing mmap for a real `-shm`. With those, Mode 1 gets the faithful
three-byte-range ladder (true concurrent readers) and WAL goes multi-process. The hope is that this
turns into a focused, useful contribution upstream to Deno itself, help on that front is very
welcome.

---

## Contributing

Contributions, issues, questions, and code review are all genuinely welcome, this is built in public
partly so others can poke at it. Whether you want to fix a bug, add a proof to the harness, improve
the docs, or just ask how something works, please jump in. **See
[CONTRIBUTING.md](./CONTRIBUTING.md) for a full guide** to getting oriented, running the suite, and
what a good PR looks like.

The quick version, the gate every change keeps green:

```bash
deno task check         # fmt --check, lint, type-check, type-aware lint, test
deno task test          # full suite
deno task test:soak     # Mode 1 multi-process soak (SQLITE_DENO_SOAK=1, CPU-oversubscribed)
deno task test:soak:wal # Mode 2 WAL crash-sweep soak
deno task bench         # hot-path measurement
```

Two principles guide the project, and they exist to keep it trustworthy rather than to gatekeep:

- **A database must not lose your data.** So no concurrency or durability mode is exposed until its
  crash/concurrency harness is green, including a negative control that proves the harness can
  actually catch corruption. Adding new proofs here is one of the most valuable things you can
  contribute.
- **The permission model stays intact.** No change may require a grant beyond
  `--allow-read`/`--allow-write` on the target database, and no code path acquires a permission the
  caller did not pass in. No FFI, no network, no ambient filesystem.

The toolchain is entirely Deno's built-ins (`deno check` / `lint` / `fmt` / `test` / `bench`) plus a
pinned, checksum-verified Biome for type-aware lint (dev/CI only, never shipped). The
[roadmap](#roadmap) and the issue tracker are the best places to find where help is wanted.

---

## License

[MIT](./LICENSE) © 2026 ul0gic
