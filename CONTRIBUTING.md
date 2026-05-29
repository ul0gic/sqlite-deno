# Contributing to sqlite-deno

Thanks for being here. This is a build-in-public project, and contributions of every kind are
welcome — code, bug reports, questions, documentation, test cases, and code review all genuinely
help. You do not need to be a SQLite internals expert or a Deno core contributor to be useful; some
of the most valuable contributions are a clear bug report, a doc fix, or a new test that catches
something we missed.

If you are reading this trying to decide whether to get involved: please do. Open an issue, ask a
question, or send a small PR. We would rather hear from you early than have you stuck.

---

## What this project is (the 60-second version)

`sqlite-deno` is a SQLite for Deno that runs on the SQLite team's official WebAssembly build, with a
pure-TypeScript VFS that maps SQLite's file I/O onto Deno's filesystem API. The goal is to keep
Deno's permission model fully intact (no FFI, no network, no ambient filesystem) and to run
everywhere Deno runs, including Deno Deploy and the edge.

The README has the full story, the honest limitations, and the comparison with the alternatives.
Read [the status section](./README.md#-status-engine-working-and-tested-library-not-yet-usable)
first — the engine works and is tested, but the public `Database`/`Statement` API is not built yet
(that is Phase 7).

---

## Getting started

```bash
# 1. Clone and enter
git clone https://github.com/ul0gic/sqlite-deno && cd sqlite-deno

# 2. Run the gate — this is also the fastest way to confirm your setup works
deno task check
```

`deno task check` is the one command to know. It runs, in order:

| Step                   | What it checks                                                     |
| ---------------------- | ------------------------------------------------------------------ |
| `deno fmt --check`     | formatting (never hand-format; `deno fmt` owns it)                 |
| `deno lint`            | lint rules — zero warnings, zero suppressions                      |
| `deno check`           | TypeScript types — zero errors                                     |
| `deno task lint:biome` | type-aware lint via a pinned, checksum-verified Biome (dev only)   |
| `deno test`            | the full test suite, including the crash and concurrency harnesses |

If `deno task check` is green from a clean clone, your environment is good and you are ready to
work.

### Where things live

- **`src/vfs/`** — the Deno-filesystem VFS, in pure TypeScript. This is the heart of the project:
  `io.ts` (read/write/sync/truncate), `namespace.ts` (open/access/delete/path resolution), `lock.ts`
  (the whole-file `flock` lock ladder), and `deno.ts` (`installDenoVfs`, which registers the VFS
  against the wasm).
- **`src/glue.ts`** — the JS↔WASM boundary. Marshals values and owns linear memory. Treat this like
  an FFI boundary: never throw across it into C, always free what you allocate.
- **`src/wasm/`** — the vendored official `@sqlite.org/sqlite-wasm` build (pinned, committed
  in-package).
- **`test/`** — mirrors `src/`. The crash and concurrency harnesses under **`test/harness/`** are
  the most important code in the repo; everything we claim about durability and concurrency is
  proven there.

### Running a single suite

The full suite runs scoped to the minimal permissions it needs. To run one file while you iterate:

```bash
# one surface, scoped to exactly the access it needs
deno test --allow-read --allow-write test/vfs/deno_fs_roundtrip_test.ts

# the multi-process concurrency soak (env-gated, oversubscribes CPU on purpose)
SQLITE_DENO_SOAK=1 deno task test:soak

# the WAL crash-sweep soak
SQLITE_DENO_SOAK=1 deno task test:soak:wal
```

A suite that needs only `--allow-read=./test.db` is itself evidence of the package's small
permission footprint — that is by design, so please keep new tests scoped to the minimum they need.

---

## The two things we hold firmly (and why)

These are not hazing rituals. They are the two properties that make the package worth trusting, so
we ask every change to respect them. Within those two lines, we are flexible and happy to help you
get a change over the line.

### 1. A database must not silently lose your data

**No concurrency or durability mode is exposed until its crash/concurrency harness is green —
including a negative control.** The negative control is the part that matters: a harness that only
ever passes proves nothing, so each one includes a deliberately broken variant (for example, a lying
no-op `xSync`) and we require the harness to _catch_ it. A mode that cannot be proven this way stays
single-process-only or stays unshipped, rather than shipping with "it mostly works."

If you are adding behavior that touches durability or cross-process locking, the most welcome
contribution is **a proof in `test/harness/` to go with it** — including the negative control that
shows the proof has teeth. If you are not sure how to structure that, open an issue or a draft PR
and we will help. Adding coverage to the harness is one of the highest-value things anyone can do
here.

### 2. The permission model stays intact

No change may require a grant beyond `--allow-read` / `--allow-write` on the target database, and no
code path may acquire a permission the caller did not pass in. Concretely:

- No FFI, no `--allow-net`, no `--allow-env` for discovery, no `--allow-write` for runtime
  extraction.
- Capabilities are passed in, never acquired. A function that needs a file takes a path or an open
  handle; it never reaches for ambient access.
- No `Deno.permissions.request`.

If a change seems to need a broader grant, that is usually a signal to rethink the boundary — and a
good thing to raise in an issue before writing much code.

---

## Filing an issue

Good issues make the project better even when no code is attached. A useful bug report includes:

- **What you did** — ideally the smallest snippet or command that reproduces it.
- **What you expected** and **what happened** — including the exact error or result code if there is
  one.
- **Environment** — Deno version (`deno --version`), OS and filesystem if it is durability- or
  locking-related (ext4, APFS, NFS, etc.), and the permission flags you ran with.

For a feature idea or design question, just describe the problem you are trying to solve. Pointing
at a concrete use case is more useful than a proposed implementation.

Questions are welcome as issues too. If something in the README or the code is unclear, that is a
documentation bug worth filing.

---

## Proposing a change / what a good PR looks like

1. **Open an issue first for anything non-trivial.** A quick conversation up front saves rework,
   especially for anything touching the VFS, locking, durability, or the permission boundary. Small
   fixes (docs, typos, an obvious bug with a test) can go straight to a PR.
2. **Keep the gate green.** `deno task check` must pass with zero failures, zero lint warnings, and
   zero suppressions. CI runs the same gate.
3. **Match the code around you.** The project is functional-by-default TypeScript with a strict
   compiler. Let `deno fmt` handle formatting; do not reformat to taste.
4. **Explain the why.** Commit messages and the PR description should say _why_ the change is needed
   — the diff already shows what. If a change fixes a corruption or durability hazard, describe the
   hazard and point at the test that now guards against it.
5. **Add or update tests.** New behavior comes with tests; a durability/concurrency change comes
   with a harness proof and its negative control. A bug fix comes with a regression test.
6. **Keep PRs focused.** One logical change per PR is easier to review and easier to trust.

Do not worry about getting everything perfect on the first try — that is what review is for. A draft
PR with a clear question is a great way to start.

---

## Where help is wanted

The [roadmap in the README](./README.md#roadmap) and the issue tracker are the best maps of where
the project is going and where contributions land most usefully. A few standing areas:

- **More crash and concurrency proofs** — broader workloads, more seeds, more hostile inputs.
- **Documentation** — clarity fixes, examples, and explaining anything that tripped you up.
- **Platform coverage** — durability behavior is verified on Linux; macOS and Windows verification
  is genuinely open work.
- **The v2 direction** — multi-process WAL depends on byte-range `fcntl` locking and `mmap` landing
  in Deno core. If you are interested in upstream Deno runtime work, that is a high-leverage place
  to help.

Thanks again for contributing. The point of building in public is that other people get to shape it
too.

---

## License

By contributing, you agree that your contributions are licensed under the same
[MIT License](./LICENSE) that covers the project.
