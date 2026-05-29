import { assert, assertEquals } from "@std/assert";
import { loadSqlite3, type Sqlite3 } from "../../src/glue.ts";
import { installCrashVfs } from "./crash-vfs.ts";
import { runWalSweep, type WalSweepFailure } from "./wal-sweep.ts";
import {
  corruptionViolations,
  droppedAnyCommitted,
  runMidLogCorruption,
} from "./wal-corruption.ts";
import { CHECKPOINT_MODES, runCheckpointCrash } from "./wal-checkpoint.ts";
import { WAL_VARIANTS } from "./wal-reconstruct.ts";

const SOAK = Deno.env.get("SQLITE_DENO_SOAK") === "1";

const SEEDS = SOAK
  ? [1, 7, 1337, 90210, 2654435761, 0x5eed, 0xc0ffee, 0xdecafbad, 42, 86753]
  : [1, 7, 1337];
const TXNS = SOAK ? 8 : 4;
const ROWS_PER_TXN = SOAK ? 4 : 2;
const RECON_PER_POINT = SOAK ? 8 : WAL_VARIANTS.length;
const CKPT_RECON = SOAK ? 8 : 6;

const withCrashVfs = async <T>(
  vfsName: string,
  realSync: boolean,
  fn: (
    sqlite3: Sqlite3,
    recorder: ReturnType<typeof installCrashVfs>,
    dir: string,
  ) => T | Promise<T>,
): Promise<T> => {
  const sqlite3 = await loadSqlite3();
  const recorder = installCrashVfs(sqlite3, { vfsName, realSync, dirSync: true });
  const dir = await Deno.makeTempDir({ prefix: "wal-crash-sweep-" });
  try {
    return await fn(sqlite3, recorder, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const fmtFailures = (failures: readonly WalSweepFailure[]): string =>
  failures
    .slice(0, 10)
    .map((f) => `k=${f.crashIndex} ${f.content}/${f.tail} subSeed=${f.subSeed}: ${f.detail}`)
    .join("\n");

Deno.test("WAL crash sweep at synchronous=FULL: every crash point keeps committed txns and integrity (I1+I2+I3)", async () => {
  await withCrashVfs("wal-sweep-full", true, (sqlite3, recorder, dir) => {
    for (const seed of SEEDS) {
      const res = runWalSweep(sqlite3, recorder, dir, {
        spec: { txns: TXNS, rowsPerTxn: ROWS_PER_TXN, dbName: "/wal-full.db", synchronous: "FULL" },
        seed,
        reconstructionsPerPoint: RECON_PER_POINT,
      });
      assert(res.crashPoints > 20, `seed ${seed} swept too few crash points: ${res.crashPoints}`);
      assert(
        res.shmIrrelevantChecks > 0,
        `seed ${seed} never exercised the I3 stray-shm-irrelevant check`,
      );
      assertEquals(
        res.shmObserved,
        false,
        "I3: a reconstruction materialized a -shm (Mode 2 never writes one)",
      );
      assertEquals(
        res.failures.length,
        0,
        `seed ${seed}: ${res.failures.length} I1/I2/I3 failures across ${res.reconstructions} reconstructions:\n${
          fmtFailures(res.failures)
        }`,
      );
    }
  });
});

Deno.test("WAL crash sweep at synchronous=NORMAL: integrity-safe, trailing-unsynced commits may be absent (no I2 violation)", async () => {
  await withCrashVfs("wal-sweep-normal", true, (sqlite3, recorder, dir) => {
    for (const seed of SEEDS) {
      const res = runWalSweep(sqlite3, recorder, dir, {
        spec: {
          txns: TXNS,
          rowsPerTxn: ROWS_PER_TXN,
          dbName: "/wal-normal.db",
          synchronous: "NORMAL",
        },
        seed,
        reconstructionsPerPoint: RECON_PER_POINT,
      });
      assertEquals(res.shmObserved, false, "I3: NORMAL run materialized a -shm");
      assertEquals(
        res.failures.length,
        0,
        `seed ${seed}: ${res.failures.length} failures at NORMAL (only durable commits required present):\n${
          fmtFailures(res.failures)
        }`,
      );
    }
  });
});

Deno.test("negative control: a lying no-op xSync drops the -wal commit frame and is CAUGHT (I1/I2 fail)", async () => {
  await withCrashVfs("wal-sweep-noopsync", false, (sqlite3, recorder, dir) => {
    const res = runWalSweep(sqlite3, recorder, dir, {
      spec: { txns: 4, rowsPerTxn: 2, dbName: "/wal-lie.db", synchronous: "FULL" },
      seed: 0xbad5,
      reconstructionsPerPoint: 8,
    });
    assert(
      res.failures.length > 0,
      `the harness FAILED to catch a lying xSync — it cannot detect WAL corruption, so it proves nothing (recon=${res.reconstructions})`,
    );
    assert(
      res.failures.some((f) => f.detail.startsWith("I2")),
      `expected a lost-committed (I2) failure from the dropped -wal commit frame; got:\n${
        fmtFailures(res.failures)
      }`,
    );
  });
});

Deno.test("negative control: a corrupt mid-log frame checksum stops recovery at the break (no value from past it leaks)", async () => {
  await withCrashVfs("wal-midlog-corrupt", true, (sqlite3, recorder, dir) => {
    const res = runMidLogCorruption(
      sqlite3,
      recorder,
      dir,
      { txns: 6, rowsPerTxn: 1, dbName: "/wal-corrupt.db", synchronous: "FULL" },
      0x1234,
    );
    assert(res.nFrames > 4, `too few frames to exercise mid-log corruption: ${res.nFrames}`);
    const violations = corruptionViolations(res);
    assertEquals(
      violations.length,
      0,
      `recovery surfaced data from past a broken-checksum frame (recovery or harness is lying):\n${
        violations.join("\n")
      }`,
    );
    assert(
      droppedAnyCommitted(res),
      "no corruption point dropped a committed value — the control is vacuous, it proves nothing",
    );
  });
});

Deno.test("checkpoint-crash: crashing during PASSIVE/FULL/RESTART/TRUNCATE recovers consistently (I1+I2)", async () => {
  await withCrashVfs("wal-checkpoint-crash", true, (sqlite3, recorder, dir) => {
    for (const mode of CHECKPOINT_MODES) {
      const res = runCheckpointCrash(sqlite3, recorder, dir, {
        dbName: `/ckpt-${mode}.db`,
        mode,
        preCommits: 4,
        postCommits: 3,
        seed: 0x9e3779b1,
        reconstructionsPerPoint: CKPT_RECON,
      });
      assert(
        res.checkpointCrashPoints > 0,
        `checkpoint(${mode}) produced no crash points to sweep`,
      );
      assertEquals(
        res.failures.length,
        0,
        `checkpoint(${mode}): ${res.failures.length} failures across ${res.reconstructions} reconstructions:\n${
          res.failures.slice(0, 8).map((f) =>
            `k=${f.crashIndex} ${f.phase} ${f.content}/${f.tail}: ${f.detail}`
          )
            .join("\n")
        }`,
      );
    }
  });
});

Deno.test("salt-advance anti-stale-replay: post-TRUNCATE frames never resurrect a pre-checkpoint frame", async () => {
  await withCrashVfs("wal-salt-advance", true, (sqlite3, recorder, dir) => {
    const res = runCheckpointCrash(sqlite3, recorder, dir, {
      dbName: "/salt-advance.db",
      mode: "TRUNCATE",
      preCommits: 3,
      postCommits: 4,
      seed: 0x5a17,
      reconstructionsPerPoint: CKPT_RECON,
    });
    assertEquals(
      res.failures.length,
      0,
      `a pre-checkpoint frame resurfaced after the salt advance (stale replay):\n${
        res.failures.slice(0, 8).map((f) => `k=${f.crashIndex} ${f.phase}: ${f.detail}`).join("\n")
      }`,
    );
  });
});
