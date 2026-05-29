# sqlite-deno

> **A true-Deno SQLite — WASM-based, with zero compromises to Deno's permission model.** No FFI. No
> network. No native modules. No runtime downloads. The same single artifact runs everywhere Deno
> runs, including Deno Deploy and the edge.

This is a **build-in-public** repository. The engine — a pure-TypeScript Deno-filesystem VFS over
the SQLite team's official WebAssembly build, with two concurrency modes and crash recovery — is
built and tested against a deterministic crash/concurrency harness. The public API is **not built
yet**. Please read the status section before anything else, so you know exactly what works today.

---

## ⚠️ Status: engine working and tested, library not yet usable

**Phase 6 of 10 complete.** You **cannot** `import` and open a database from this package today —
there is no `openDatabase`, no `Database`, no `Statement`. That is Phase 7.

Here is what is built so far. The foundation — the VFS, the locking, and the crash-recovery behavior
— comes first, because everything above it depends on getting these right:

|                                  |                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Working and tested**           | The Deno-filesystem VFS (pure TypeScript, over `Deno.*Sync`). Both concurrency modes. Crash / power-loss recovery, on Linux (model-bounded — see [the caveats](#the-honest-capability-envelope-the-asterisks-each-with-the-why)). |
| **Not built**                    | The public API (`openDatabase`, `Database`, `Statement`, transactions). The reproducible byte-identical wasm build. The JSR release.                                                                                              |
| **Vendored, not yet self-built** | The wasm is the official `@sqlite.org/sqlite-wasm` `3.53.0-build1`, committed in-package (see [`WASM_VENDOR.md`](./WASM_VENDOR.md)). Building our own byte-for-byte from pinned source is Phase 9 and is **0% done**.             |

```
v0 — prove the path
  Phase 1  Scaffold & toolchain        ████████████████████  100%  done
  Phase 2  WASM integration spike      ████████████████████  100%  done
  Phase 3  Deno-FS VFS (file-backed)   ████████████████████  100%  done
v1 — public launch
  Phase 4  Crash-sim harness           ████████████████████  100%  done
  Phase 5  Mode 1 — rollback locks     ████████████████████  100%  done
  Phase 6  Mode 2 — WAL (exclusive)    ████████████████████  100%  done
  Phase 7  Public API & bindings       ░░░░░░░░░░░░░░░░░░░░    0%  next
  Phase 8  Full test suite (L1–L6)     ░░░░░░░░░░░░░░░░░░░░    0%
  Phase 9  Reproducible build & CI     ░░░░░░░░░░░░░░░░░░░░    0%
  Phase 10 JSR publish & docs          ░░░░░░░░░░░░░░░░░░░░    0%
v2 — multi-process WAL                 ░░░░░░░░░░░░░░░░░░░░    0%  (gated on Deno core)
```

### How to read this repo right now

```bash
git clone <this-repo> && cd sqlite-deno
deno task check     # fmt, lint, type-check, and the full proof suite (69 tests)
```

- The engine entry points live in [`src/vfs/`](./src/vfs/) — `installDenoVfs` (in
  [`src/vfs/deno.ts`](./src/vfs/deno.ts)) is what registers our VFS against the wasm.
- The exported surface today ([`src/mod.ts`](./src/mod.ts)) is the engine, not a library:
  `loadSqlite3`, `installDenoVfs`, `installMemoryVfs`. You drive SQLite through `sqlite3.oo1.DB`
  after installing the VFS — that is a proving harness, not the intended ergonomic API.
- The proofs are in [`test/`](./test/) — the crash and concurrency harnesses under
  [`test/harness/`](./test/harness/) are the most important code in the project.

---

## What it is, and why it exists

There are several good SQLite options for Deno already, and each is a sensible choice for a
different problem. The combination none of them offers in one package is **permission-respecting,
WAL-capable, and able to run everywhere Deno runs** — and that is the niche this project aims to
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
the goal — to cover that specific gap well, not to replace anything that already works.

**The permission model is the design constraint everything else serves.**

---

## The permission story

This is the part the project cares most about getting right. The wasm has **no ambient authority**.
All of SQLite's I/O flows back out through our VFS callbacks, and those reach the filesystem only
through path-scoped `Deno.*Sync` calls. The module cannot open a file the host did not hand it. If
this package were supply-chain-compromised tomorrow, its blast radius would still be **exactly** the
paths you granted — no FFI to abuse, no network to phone home, no ambient filesystem.

What the package needs, and nothing more:

```bash
# read-only access to one database file — no --allow-ffi, no --allow-net, no --allow-env
deno run --allow-read=./app.db your_program.ts
```

### The honest durability caveat — read this

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

- Under a file-only grant the package still works and **fails closed** — it never widens your grant
  — but the directory-fsync is denied, so the last-commit durability guarantee is unavailable. We
  surface this as an error, never as a silent downgrade.

This caveat is tracked as a Phase-7 documentation obligation; the engine behavior is already correct
(fail-closed, never grant-widening).

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Your code  →  (Phase 7) public API: openDatabase, ...     │  ← not built yet
├──────────────────────────────────────────────────────────┤
│  JS↔WASM glue (src/glue.ts) — marshals values, owns memory │
├──────────────────────────────────────────────────────────┤
│  Official @sqlite.org/sqlite-wasm 3.53.0  (vendored, pinned)│  ← the SQLite engine
├──────────────────────────────────────────────────────────┤
│  Deno-FS VFS (pure TypeScript, src/vfs/*)                  │
│     installed at runtime via sqlite3.vfs.installVfs        │
│     I/O → Deno.openSync / readSync / writeSync / tryLockSync│  ← honors the grant
└──────────────────────────────────────────────────────────┘
```

The key facts:

- **No recompile.** We register a pure-JS VFS against the _prebuilt_ official wasm via `installVfs`
  — the same mechanism SQLite's own browser OPFS VFS uses. We add **no C**.
- **The VFS is simpler than the browser's.** OPFS is async but SQLite's VFS is synchronous, so the
  browser VFS needs a `SharedArrayBuffer` + `Atomics.wait` async-proxy dance. **Deno's file API is
  already synchronous**, so our VFS calls Deno I/O directly.
- **Runs on Deno Deploy and the edge** by construction — one wasm, every target, no native binaries
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
    OS lock held is only ever {none, exclusive} — never shared.
    No upgrade path exists, so the flock-upgrade hazard cannot occur.
    Consequence: multi-process SERIALIZED — one accessor at a time.
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
  Note over WAL,DB: commit is the synced commit frame — there is no journal-unlink point
  App->>SQLite: PRAGMA wal_checkpoint(TRUNCATE)
  SQLite->>VFS: read frames, write pages
  VFS->>DB: writeSync committed pages + syncSync
  SQLite->>VFS: truncate -wal
  Note over SQLite: crash recovery rebuilds the heap wal-index by scanning -wal frame headers
```

---

## What's tested, and how to verify it yourself

The correctness claims here are meant to be **executable rather than taken on faith** — please run
them and check. The whole suite runs from a clean checkout:

```bash
deno task check        # fmt --check, lint, type-check, type-aware lint, full test suite — 69 tests
deno task test:soak    # Mode 1: N real OS processes, Jepsen bank, CPU-oversubscribed (env-gated)
deno task test:soak:wal # Mode 2: multi-seed WAL crash sweep (env-gated)
```

What the suite proves:

- **Crash / power-loss recovery (Linux).** A deterministic fault-injection VFS records every write
  and sync, then a power-loss model reconstructs the disk at each crash point (synced data exact;
  unsynced data dropped, applied, or torn at sector granularity) and reopens through the _real_ VFS.
  Invariants checked at every crash point: `integrity_check = ok`, committed transactions present,
  uncommitted absent. A **negative control** (a lying no-op `xSync`) is proven to be _caught_ — a
  harness that stays green with durability disabled proves nothing. There is also a real
  `SIGKILL`-mid-write subprocess test.
- **Mode 1 concurrency.** N real OS subprocesses against one shared file, a Jepsen-style bank
  workload (balance-sum conservation, monotonic commit counter, no torn reads, periodic
  `integrity_check`), SIGKILL crash-recovery (exactly one process replays a hot journal), and a
  negative control (no-op locks → corruption detected). Soaked at 36k serialized commits under CPU
  oversubscription.
- **Mode 2 WAL crash recovery.** Crash sweep over the `-wal` op stream: torn-tail recovery to a
  consistent committed prefix, crash-during-checkpoint, salt-advance anti-stale-replay, recovery
  from `{db, -wal}` with the `-shm` deleted (the heap wal-index is rebuilt from frame headers —
  there is no `-shm`). Two negative controls caught.

These run on the **vendored** wasm and the **real** Deno-FS VFS — never a stubbed SQLite.

---

## The honest capability envelope (the asterisks, each with the why)

These are the limitations, up front, each with the reason behind it. If any of these rule the
package out for your use case, that is genuinely useful to know before you invest time in it.

### Mode 1 — rollback journal, multi-process: **serialized**

One accessor at a time. **No concurrent readers.** A reader excludes other readers _and_ writers for
as long as it holds the file.

**Why:** Deno's userland exposes only whole-file `flock`, not byte-range `fcntl`. The obvious "many
readers XOR one writer" design (shared locks for readers, upgrade to exclusive for a writer) is
**verified-unsafe** on whole-file `flock`: a Linux `flock` upgrade is non-atomic — a failed
`LOCK_SH → LOCK_EX` upgrade _drops_ the shared lock while returning failure, and SQLite's
change-counter revalidation does not fire on the busy-retry path. That is a real (rare)
silent-stale-read / stale-commit corruption window. There is no event-loop-safe way to close it
without byte-range locks. So v1 ships SQLite's own `unix-flock` protocol verbatim (`LOCK_EX` for
every level), which is **provably correct by construction** — at the cost of serialization. True
"many readers XOR one writer" needs byte-range `fcntl` and is **v2**.

> A contending connection must set a `busy_timeout` so it retries `SQLITE_BUSY` rather than failing
> immediately. All lock calls are non-blocking, so there is no OS deadlock.

### Mode 2 — WAL: **single-process exclusive only**

Real WAL, with the wal-index in heap. **No `-shm` file, no shared-memory methods.** One process owns
the file exclusively.

**Why:** multi-process WAL needs a memory-mapped `-shm` wal-index _and_ byte-range `fcntl` for
cross-process coordination — neither available from Deno userland today. Exclusive locking mode runs
WAL with the index in heap, which needs only the whole-file exclusive lock Deno already has. This is
exactly what the official `sqlite-wasm` does, and it covers the dominant Deno shape: one
long-running server process owning its database. Multi-process WAL is **v2**.

> Setting `journal_mode=WAL` without `locking_mode=EXCLUSIVE` first **fails closed** — SQLite
> returns `"delete"` (no WAL, no crash, no corruption) because the VFS has no shm.

### Durability

- **Directory-fsync is shipped and Linux-proven** (it makes journal creation/deletion survive a
  power cut). It needs the **parent-directory** grant — see
  [the permission caveat](#the-honest-durability-caveat--read-this) above.
- **WAL at `synchronous=NORMAL` is consistency-safe but NOT power-loss-durable for the last
  commit(s).** A transaction that returned `COMMIT` at `NORMAL` can roll back after a power cut (it
  survives an _application_ crash, just not a _power_ loss). This is documented SQLite behavior, not
  a corruption bug — `integrity_check` stays `ok`. Use `synchronous=FULL` for power-loss durability
  in WAL.
- **Windows** directory-fsync durability is **unverified** (do not rely on it). **NFS / networked
  filesystems are unsupported** — same as native SQLite.
- The crash proofs are model-bounded (a worst-legal-device power-loss model + Linux
  `strace`-verified primitives), **not** real-hardware power-cut testing. A hardware rig is a later
  release-hardening layer.

---

## What we ran into and decided (the engineering story)

The decisions below are the durable record of _why_ the thing is built the way it is, including the
times the first attempt was wrong. The guiding rule: **no concurrency or durability mode ships until
its harness proves it — for a database, "mostly works" is silent corruption waiting to happen.**
Twice this discipline caught a corruption hole that would otherwise have shipped, and both are
written up below, mistakes included.

### WASM, not FFI — to keep the permission model intact

FFI would be faster and simpler to build. The trade-off is that it requires `--allow-ffi` (which
widens Deno's permission model), downloads a native binary at first run, and does not run on Deno
Deploy. This project takes the other side of that trade: WASM with a VFS, so the engine has **no
ambient authority** and the blast radius is exactly the granted paths. The cost is some write
throughput; the gain is the permission model, the edge, and a verifiable supply chain. That trade is
laid out plainly in the matrix below — including where it loses.

### A pure-TypeScript VFS — no recompile, edge-compatible

Rather than fork an existing lineage or compile our own wasm, the project consumes the official
`@sqlite.org/sqlite-wasm` and registers a VFS against it in pure TypeScript via `installVfs`. v1
carries **no C toolchain** — the package is auditable TypeScript over a pinned wasm blob. We did not
fork `@db/sqlite` (its architecture is FFI-first, a different and valid design) nor the `dyedgreen`
lineage (it predates the official wasm build that makes this VFS approach practical); building fresh
on the official wasm was the cleanest fit for the permission-first goal here.

### The crash harness as a gate — built _before_ locking and WAL

The most load-bearing code in the project is a deterministic crash-simulation VFS, built _before_
any locking or WAL so every later mode can be checked against it. A locking or WAL mode is exposed
only after its crash + concurrency harness is green, including a **negative control** that proves
the harness can actually fail (a harness that stays green with durability disabled would prove
nothing). This is the one rule we hold firmly: a red harness means the mode stays
single-process-only or unshipped, rather than "ship it and watch."

### BUG-001 — the crash harness found _silent_ committed-data loss, and the first fix was wrong

The harness found that in DELETE journal mode a committed transaction could be **silently lost**
(`integrity_check` still `ok`!) after a power cut: a "zombie" hot journal reappears and SQLite rolls
the committed pages back. The first diagnosed root cause — _"Deno cannot fsync a directory"_ — was
**wrong**. A 30-second `strace` probe showed `Deno.openSync(dir).syncSync()` _is_ a directory fsync
(`openat` + `fsync`); the VFS simply wasn't issuing it. The real fixes: default to
`journal_mode=PERSIST` (durable via file-content fsync, no directory round-trip) **and** issue the
directory fsync in the VFS where SQLite expects it. Both are harness-proven on Linux. The lesson:
verify the root cause against the artifact before designing around it.

### The X-strict pivot — we _retreated_ from an unproven concurrent-reader design

The first Mode-1 draft was the clever "many readers XOR one writer" design. Verifying it against the
pinned SQLite source (`os_unix.c`, `pager.c`) and probing Linux `flock` revealed the
non-atomic-upgrade corruption hazard described above — and that the SQLite revalidation we were
counting on to save us **does not fire** on the relevant path. Rather than ship an unproven
concurrency win, we _retreated_ to the provably-safe serialized design (SQLite's own `unix-flock`
protocol) and deferred concurrent readers to v2. Shipping less, proven, beat shipping more,
unproven.

---

## Honest comparison matrix

A fair read of where this sits among good alternatives. It is slower on raw write throughput, and
trades that for the permission model and edge support. None of the alternatives are strawmen — each
is a reasonable choice, and for many projects the right one.

|                                 | **sqlite-deno** (this)                          | `@db/sqlite` (FFI)                 | `node:sqlite` (built-in)                        | `dyedgreen/deno-sqlite` (WASM)     | `@sqlite.org/sqlite-wasm` (official)  |
| ------------------------------- | ----------------------------------------------- | ---------------------------------- | ----------------------------------------------- | ---------------------------------- | ------------------------------------- |
| Engine                          | WASM (official)                                 | native (FFI)                       | native (built into Deno)                        | WASM (own build)                   | WASM (official)                       |
| Permission grant                | `--allow-read`/`-write` only                    | **needs `--allow-ffi`**            | engine is native; not the Deno permission story | `--allow-read`/`-write` only       | read of wasm only (browser-first)     |
| Runtime download                | none (in-package)                               | **downloads a `.so` at first run** | none (in Deno)                                  | none                               | none                                  |
| Runs on Deno Deploy / edge      | **yes**                                         | **no** (no FFI)                    | yes                                             | yes                                | designed for the browser, not Deno FS |
| WAL                             | **yes** (single-process, v1)                    | yes (full)                         | yes (native)                                    | **no**                             | yes (browser/OPFS)                    |
| Multi-process                   | yes — **serialized** (v1); full WAL in v2       | yes (full byte-range)              | yes (native)                                    | yes (rollback, readers-XOR-writer) | n/a (browser)                         |
| Bulk-write throughput           | slower (WASM) — **we lose here**                | **fastest**                        | fast (native)                                   | slower (WASM)                      | slower (WASM)                         |
| Reproducible build / provenance | **planned** (Phase 9–10, OIDC) — vendored today | binary from a release              | ships with Deno                                 | own build                          | npm-published                         |
| Deno-filesystem VFS             | **yes** (pure TS)                               | n/a (native)                       | n/a (native)                                    | yes                                | no (OPFS-oriented)                    |
| **Usable as a library today**   | **NO — engine only, API is Phase 7**            | yes                                | yes                                             | yes                                | yes (browser)                         |

Take-away: if you need maximum bulk-write speed and `--allow-ffi` is acceptable, `@db/sqlite` is an
excellent choice. If what you need is an embedded SQLite that **keeps Deno's permission model intact
and runs on the edge**, that is the gap this project is aiming at — once Phase 7 lands.

---

## Roadmap

**v1 (public launch):**

- **Phase 7 — Public API.** `openDatabase`, `Database`, typed `Statement<Row>`, transactions,
  `using`/`Symbol.dispose` lifetimes, Web-Streams result streaming. Mode selection is explicit and
  constrained at open (illegal combos unrepresentable), so a caller cannot accidentally leave the
  tested engine envelope. No user-defined SQL functions in v1 (that JS-callback-reentrancy surface
  is one place native engines have historically hit use-after-free; it waits until the reentrancy
  model is tested).
- **Phase 8 — Full L1–L6 test suite** (functional, permission, crash/durability, concurrency,
  borrowed SQLite/fuzz corpora, build).
- **Phase 9 — Reproducible byte-identical wasm build.** Today the wasm is the **vendored** official
  artifact; compiling our own byte-for-byte from pinned SQLite source + pinned toolchain, with a
  `verify-build.sh` a stranger can run, is **not done**.
- **Phase 10 — JSR publish** with OIDC provenance, immutable versions, API reference.

**v2 — multi-process WAL.** Gated on contributing byte-range `fcntl(F_OFD_SETLK)` locking to Deno
core (`ext/io/fs.rs`) and exposing mmap for a real `-shm`. With those, Mode 1 gets the faithful
three-byte-range ladder (true concurrent readers) and WAL goes multi-process. The hope is that this
turns into a focused, useful contribution upstream to Deno itself — help on that front is very
welcome.

---

## Contributing

Contributions, issues, questions, and code review are all genuinely welcome — this is built in
public partly so others can poke at it. Whether you want to fix a bug, add a proof to the harness,
improve the docs, or just ask how something works, please jump in. **See
[CONTRIBUTING.md](./CONTRIBUTING.md) for a full guide** to getting oriented, running the suite, and
what a good PR looks like.

The quick version — the gate every change keeps green:

```bash
deno task check         # fmt --check, lint, type-check, type-aware lint, test
deno task test          # full suite
deno task test:soak     # Mode 1 multi-process soak (SQLITE_DENO_SOAK=1, CPU-oversubscribed)
deno task test:soak:wal # Mode 2 WAL crash-sweep soak
deno task bench         # hot-path measurement
```

Two principles guide the project, and they exist to keep it trustworthy rather than to gatekeep:

- **A database must not lose your data.** So no concurrency or durability mode is exposed until its
  crash/concurrency harness is green — including a negative control that proves the harness can
  actually catch corruption. Adding new proofs here is one of the most valuable things you can
  contribute.
- **The permission model stays intact.** No change may require a grant beyond
  `--allow-read`/`--allow-write` on the target database, and no code path acquires a permission the
  caller did not pass in. No FFI, no network, no ambient filesystem.

The toolchain is entirely Deno's built-ins (`deno check` / `lint` / `fmt` / `test` / `bench`) plus a
pinned, checksum-verified Biome for type-aware lint (dev/CI only — never shipped). The
[roadmap](#roadmap) and the issue tracker are the best places to find where help is wanted.

---

## License

[MIT](./LICENSE) © 2026 ul0gic
