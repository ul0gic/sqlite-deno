import { assert, assertEquals } from "@std/assert";
import { runFinalizationAb } from "./journal_mode_durability.ts";
import type { JournalMode, WorkloadSpec } from "./workload.ts";
import {
  commitLossFailures,
  fmtFailures,
  integrityFailures,
  runMatrixSweep,
  SWEEP_SEEDS,
  withSweepVfs,
} from "../fixtures/crash_sweep_harness.ts";

const sweepZeroDirDurability = (mode: JournalMode): void => {
  Deno.test(
    `journal_mode=${mode}: survives the full crash sweep with ZERO directory durability`,
    async () => {
      const res = await runMatrixSweep({
        cell: { journalMode: mode, dirSync: false, dentryDurable: false },
        txns: 5,
        rowsPerTxn: 2,
        dbName: `/${mode.toLowerCase()}.db`,
        seeds: SWEEP_SEEDS,
        reconstructionsPerPoint: 8,
        vfsName: `jmode-sweep-${mode}`,
      });
      assert(res.crashPoints > 20, `${mode} swept too few crash points: ${res.crashPoints}`);
      assertEquals(
        res.failures.length,
        0,
        `${mode} LOST a committed txn or corrupted (I1/I2) across ${res.reconstructions} reconstructions with no directory durability:\n${
          fmtFailures(res.failures)
        }`,
      );
    },
  );
};

sweepZeroDirDurability("PERSIST");
sweepZeroDirDurability("TRUNCATE");

const finalizationAb = (mode: JournalMode): void => {
  Deno.test(
    `journal_mode=${mode}: committed txn survives a DROPPED invalidation (A/B, zombie journal present)`,
    async () => {
      await withSweepVfs(
        { vfsName: `jmode-ab-${mode}`, realSync: true, tempPrefix: "jmode-" },
        async ({ sqlite3, recorder, dir }) => {
          const spec: WorkloadSpec = {
            txns: 4,
            rowsPerTxn: 2,
            dbName: `/${mode.toLowerCase()}ab.db`,
          };
          let exercisedDangerous = 0;
          for (const seed of SWEEP_SEEDS) {
            const res = await runFinalizationAb(sqlite3, recorder, dir, spec, mode, seed);
            assert(
              res.points.length > 0,
              `${mode} seed ${seed}: no finalization points with a commit`,
            );
            for (const p of res.points) {
              assert(
                p.durableOk,
                `${mode} seed ${seed} k=${p.crashIndex}: A (invalidation durable) lost a committed txn — control broken`,
              );
              assert(
                p.droppedOk,
                `${mode} seed ${seed} k=${p.crashIndex}: B DROPPED invalidation lost committed [${p.committed}]; present=[${p.droppedPresent}] (${p.droppedDetail})`,
              );
              if (p.zombieJournalOnDisk) exercisedDangerous++;
            }
          }
          assert(
            exercisedDangerous > 0,
            `${mode}: the A/B never materialized a valid-header zombie journal — the dangerous case was not exercised, so the pass is vacuous`,
          );
        },
      );
    },
  );
};

finalizationAb("PERSIST");
finalizationAb("TRUNCATE");

const negativeControl = (mode: JournalMode): void => {
  Deno.test(
    `negative control journal_mode=${mode}: a lying no-op xSync is CAUGHT`,
    async () => {
      const res = await runMatrixSweep({
        cell: { journalMode: mode, dirSync: false, dentryDurable: false },
        txns: 4,
        rowsPerTxn: 2,
        dbName: `/${mode.toLowerCase()}lie.db`,
        seeds: [424242],
        reconstructionsPerPoint: 8,
        realSync: false,
        vfsName: `jmode-noop-${mode}`,
      });
      assert(
        res.failures.length > 0,
        `${mode} harness FAILED to catch a broken xSync (recon=${res.reconstructions}) — it proves nothing`,
      );
      assert(
        integrityFailures(res.failures).length > 0,
        `${mode}: expected at least one integrity (I1) failure from unsynced corruption`,
      );
    },
  );
};

negativeControl("PERSIST");
negativeControl("TRUNCATE");

Deno.test(
  "baseline journal_mode=DELETE: the full sweep with ZERO directory durability STILL loses a committed txn (BUG-001 holds)",
  async () => {
    const res = await runMatrixSweep({
      cell: { journalMode: "DELETE", dirSync: false, dentryDurable: false },
      txns: 4,
      rowsPerTxn: 2,
      dbName: "/delete.db",
      seeds: SWEEP_SEEDS,
      reconstructionsPerPoint: 8,
      vfsName: "jmode-delete-baseline",
    });
    assert(
      commitLossFailures(res.failures).length > 0,
      "DELETE mode no longer loses a committed txn under zero directory durability — either a dir-fsync landed (re-adjudicate BUG-001) or the model stopped dropping the unlink dentry; do not silently relax it",
    );
  },
);
