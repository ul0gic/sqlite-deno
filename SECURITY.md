# Security Policy

The reason this project exists is to be a SQLite for Deno that does not weaken Deno's permission
model. Security is the design constraint, not an afterthought, so this policy explains the model the
package is built on, what is in and out of scope for a report, and how to report a vulnerability.

> **Status note.** There is no usable library release yet — the public `Database`/`Statement` API is
> not built (it is Phase 7; see the [README](./README.md)). What exists today is the engine: a
> pure-TypeScript Deno-filesystem VFS over the official SQLite WebAssembly build, with
> crash/concurrency proofs. A report against the engine, the VFS, or the supply-chain claims is
> welcome and in scope.

---

## The security model (the blast-radius guarantee)

The package's reach is meant to be **exactly** the files you grant it through Deno's `--allow-read`
/ `--allow-write` flags — and nothing more.

- **No FFI, no network, no ambient filesystem.** The package does not use `--allow-ffi`, does not
  open network connections, and does not reach for files outside the paths you granted. It does not
  call `Deno.permissions.request`; it never widens the grant you gave it.
- **The WebAssembly module has no ambient authority.** SQLite runs as WASM. All of its file I/O
  flows back out through our VFS callbacks, and those reach the filesystem only through path-scoped
  `Deno.*Sync` calls. The module cannot open a file the host did not hand it.
- **The blast radius holds even under compromise.** If this package were supply-chain compromised
  tomorrow, its reach would still be limited to the paths you granted — because the runtime has no
  FFI to abuse, no network to phone home, and no ambient filesystem to walk. That containment is the
  property the whole design serves.
- **A database file is treated as untrusted input.** A corrupt or hostile SQLite file must not be
  able to exploit the VFS or the bindings. We rely on SQLite's own robustness for the engine, and
  the VFS bounds-checks what it reads rather than trusting length fields from the file to size host
  allocations.

Durable writes need a slightly wider grant than reads. A crash-safe commit requires SQLite to
`fsync` the **directory** containing the database, which is a read of the directory path — a
file-only grant does not cover it. Under a file-only grant the package still works and **fails
closed** (it surfaces an error rather than silently dropping the durability guarantee or widening
your grant). The [README permission section](./README.md#the-permission-story) has the full detail.

---

## Supported scope (honestly)

The same honest limits the README states apply here:

- **The engine is at the proven-but-pre-API stage.** The VFS, both concurrency modes, and the
  crash-recovery behavior are built and tested against a deterministic crash/concurrency harness.
  There is no published library release to apply a security fix to yet, so "supported versions" is
  best read as: the `main` branch is where fixes land.
- **Durability is verified on Linux.** Directory-fsync durability on **Windows is unverified** — do
  not rely on it. **NFS and other networked filesystems are unsupported**, the same as native
  SQLite.
- **The crash proofs are model-bounded** — a worst-legal-device power-loss model plus
  `strace`-verified primitives, not real-hardware power-cut testing. A hardware rig is a later
  release-hardening layer.
- **The WASM is vendored today, not yet self-built.** It is the official `@sqlite.org/sqlite-wasm`
  build, committed in-package (see [`WASM_VENDOR.md`](./WASM_VENDOR.md)). The reproducible
  byte-for-byte build from pinned source, with a `verify-build.sh` a stranger can run, is Phase 9
  and not done yet.

---

## Reporting a vulnerability

Please report security issues **privately** rather than opening a public issue, so a fix can be
prepared before the details are public.

**Preferred: GitHub private vulnerability reporting.** On this repository, go to the **Security**
tab and choose **Report a vulnerability**. This opens a private advisory visible only to the
maintainer and you.

> **Maintainer to-do:** private vulnerability reporting must be enabled in repository settings
> (**Settings → Code security and analysis → Private vulnerability reporting**) for the "Report a
> vulnerability" button to appear. Until it is enabled, there is no private channel — please enable
> it.

If private reporting is not yet available and the issue is sensitive, please hold the details and
ask the maintainer (for example, in a non-sensitive issue that simply requests a private channel)
before disclosing publicly.

When you report, the most useful details are:

- What the issue is and the impact you believe it has.
- The smallest steps or snippet that reproduce it.
- Your environment — Deno version, OS, and filesystem (ext4 / APFS / NFS) if the issue touches
  durability or locking.

There is no bug-bounty program; this is a volunteer build-in-public project. Reports are still
genuinely valued, and credit will be given to reporters who want it.

---

## What is in scope

- The package reaching, reading, or writing a file **outside** the granted paths.
- Anything that lets the package acquire a permission the caller did not pass in, or that requires a
  broader grant than `--allow-read` / `--allow-write` on the target database (and its parent
  directory for durable writes).
- A corrupt or hostile **database file** that crashes, hangs, or corrupts memory in our VFS or
  bindings (the database file is untrusted input).
- Memory-safety problems at the JS↔WASM boundary — a stale view over WASM memory, an out-of-bounds
  read or write, a length field from the file used to size a host allocation without validation.
- Crash / power-loss data-loss or corruption that the harness should have caught — committed data
  lost, uncommitted data applied, or an `integrity_check` failure on a supported configuration
  (Linux).
- Supply-chain integrity issues — a way the shipped WASM could differ from the pinned source, or a
  dependency concern.

## What is out of scope

- **SQLite engine bugs.** The SQL parser, query planner, and storage engine are upstream SQLite. If
  you find a flaw in SQLite itself, please report it to the
  [SQLite project](https://www.sqlite.org/src/doc/trunk/README.md), not here. (If our VFS or
  bindings make an upstream issue reachable or worse, that part is in scope.)
- The expected, documented behaviors that are not bugs: serialized multi-process access in Mode 1,
  single-process-exclusive WAL in Mode 2, the file-only-grant durability limitation, and
  WAL-at-`synchronous=NORMAL` not being power-loss-durable for the last commit(s). These are
  documented trade-offs in the [README](./README.md), not vulnerabilities.
- Findings that depend on a grant you chose to widen yourself — for example, granting `--allow-read`
  on a directory tree far larger than the database and then observing the package can read within
  it. The package's job is to not widen your grant, not to second-guess the grant you gave.
- Issues in Deno itself or in unrelated tooling.

When in doubt, report it privately and let's figure out together where it belongs.
