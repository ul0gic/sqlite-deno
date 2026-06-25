# Testing harness

This directory holds the full test suite. It ships with the repository but **not** with the
published package (`publish.include` in `deno.json` excludes `test/`). This README documents the
harness layout and how to run it. The testing _doctrine_ — what each layer must prove and why —
lives in `.project/test-strategy.md`.

The suite uses Deno's built-in runner (`deno test`) and `@std/assert`. No third-party test
framework. Integration tests use real database files in a temp dir, the real wasm, and the real VFS.

## Layout

| Path          | Layer         | Contents                                                                                                                        |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `unit/`       | L1 functional | Public-API behavior: marshaling, open/exec/prepare/transaction lifecycle, error taxonomy, hostile input.                        |
| `permission/` | L2 permission | The grant boundary: scoped read/write works; out-of-grant, no-grant, traversal, and symlink-escape fail closed; no ffi/net/env. |
| `vfs/`        | —             | Engine/VFS-boundary tests (round-trip, locking, WAL structure) below the public API.                                            |
| `harness/`    | L3 + L4       | The crash-simulation and concurrency machinery, plus the sweeps that drive it (see below).                                      |
| `fuzz/`       | L5            | Generative SQL fuzzer + failure shrinker over the public surface.                                                               |
| `fixtures/`   | —             | Shared fakes and subprocess workers, promoted here once two tests need them.                                                    |

## Running

```bash
deno task check     # the gate: fmt --check, lint, check, lint:biome, test
deno test           # full suite (CI-bounded volume)
deno test --allow-read=./test test/vfs/lock_test.ts   # one surface, scoped
```

Run each suite with the minimal permission flags it needs; the flags document the package's
permission footprint. Suites that need a temp dir take `-A` (or a scoped `--allow-write` to that
dir); the scoped permission proofs run via in-suite subprocess workers.

## Soak suites

The soaks run heavy volume and are gated by `SQLITE_DENO_SOAK=1` so the per-commit gate stays fast
(each soak also runs a small CI-bounded slice in the normal suite). Tuning env vars and their
defaults:

| Task                 | Covers                                                                                       | Tuning (default)                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `test:soak`          | L4 multi-process concurrency stress (`concurrency_test.ts`)                                  | `SQLITE_DENO_SOAK_WORKERS` (16), `SQLITE_DENO_SOAK_TXNS` (100000), `SQLITE_DENO_SOAK_DRIVER` (`public`\|`engine`) |
| `test:soak:crash`    | L3 rollback crash sweep, full `{journalMode}×{synchronous}×{dirSync}×{dentryDurable}` matrix | `SQLITE_DENO_SOAK_CRASH_TXNS` (8), `SQLITE_DENO_SOAK_CRASH_ROWS` (4), `SQLITE_DENO_SOAK_CRASH_RECON` (10)         |
| `test:soak:wal`      | L3 WAL crash-recovery sweep, wider seed set                                                  | (gate flag only)                                                                                                  |
| `test:soak:fuzz`     | L5 generative SQL fuzz + shrinker, both open modes                                           | `SQLITE_DENO_FUZZ_SEEDS` (200), `SQLITE_DENO_FUZZ_OPS` (400)                                                      |
| `test:soak:freeform` | L3 free-form crash sweep, generated schemas as the witness                                   | `SQLITE_DENO_FREEFORM_SEEDS` (40), `SQLITE_DENO_FREEFORM_TABLES` (4), `SQLITE_DENO_FREEFORM_TXNS` (10)            |

## The crash harness

The crash sweeps share one deterministic seam:

- **`crash-vfs.ts`** — a recording crash-simulation VFS. It backs files in memory so SQLite sees
  normal I/O, while appending every write/truncate/sync/delete to an ordered op log with sync
  barriers. `realSync: false` makes `xSync` lie — the negative control.
- **`reconstruct.ts`** — replays a prefix of that op log into a plausible post-crash image: synced
  data exact, unsynced data dropped / applied / torn (sector scramble).
- **`sweep.ts` + `verify.ts`** — at every crash point and reconstruction variant, reopen the image
  through the real VFS and assert **I1** (`integrity_check = ok`) and **I2** (the durability
  witness: every committed value present, nothing uncommitted resurrected).

Two durability witnesses run over this seam:

- the fixed `kv` marker table (`workload.ts`, `workload-shape.ts`), driven across the rollback and
  WAL sweeps;
- a free-form generator (`freeform-*.ts`) where arbitrary generated multi-table schemas are
  themselves the witness, checked by exact committed-state equality.

**Negative controls are mandatory.** Every sweep includes a case where a lying no-op `xSync` (or an
injected corruption) must be _caught_ — a harness that cannot detect corruption proves nothing.

L4 concurrency (`concurrency_test.ts`, `concurrency-vfs.ts`) drives N real subprocesses through a
Jepsen-style bank workload, asserting balance-sum / monotonic commit-count / no-torn-read /
integrity invariants, with SIGKILL crash-recovery and a no-op-locks negative control.
