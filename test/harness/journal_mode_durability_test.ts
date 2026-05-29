import { assert, assertEquals } from "@std/assert";
import { loadSqlite3 } from "../../src/glue.ts";
import { installCrashVfs } from "./crash-vfs.ts";
import { runSweep } from "./sweep.ts";
import { runFinalizationAb } from "./journal_mode_durability.ts";
import type { JournalMode, WorkloadSpec } from "./workload.ts";

const SEEDS = [1, 7, 1337, 90210, 2654435761] as const;

const withVfs = async <T>(
  vfsName: string,
  realSync: boolean,
  fn: (
    sqlite3: Awaited<ReturnType<typeof loadSqlite3>>,
    recorder: ReturnType<typeof installCrashVfs>,
    dir: string,
  ) => T | Promise<T>,
): Promise<T> => {
  const sqlite3 = await loadSqlite3();
  const recorder = installCrashVfs(sqlite3, { vfsName, realSync });
  const dir = await Deno.makeTempDir({ prefix: "jmode-" });
  try {
    return await fn(sqlite3, recorder, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const fmtFailures = (
  failures: readonly { crashIndex: number; variant: string; subSeed: number; detail: string }[],
): string =>
  failures.slice(0, 8).map((f) =>
    `k=${f.crashIndex} ${f.variant} subSeed=${f.subSeed}: ${f.detail}`
  )
    .join("\n");

const sweepZeroDirDurability = (mode: JournalMode): void => {
  Deno.test(
    `journal_mode=${mode}: survives the full crash sweep with ZERO directory durability`,
    async () => {
      await withVfs(`jmode-sweep-${mode}`, true, (sqlite3, recorder, dir) => {
        for (const seed of SEEDS) {
          const spec: WorkloadSpec = {
            txns: 5,
            rowsPerTxn: 2,
            dbName: `/${mode.toLowerCase()}.db`,
            journalMode: mode,
          };
          const res = runSweep(sqlite3, recorder, dir, {
            spec,
            seed,
            reconstructionsPerPoint: 8,
            dentryDurable: false,
          });
          assert(
            res.crashPoints > 20,
            `${mode} seed ${seed} swept too few crash points: ${res.crashPoints}`,
          );
          assertEquals(
            res.failures.length,
            0,
            `${mode} seed ${seed} LOST a committed txn or corrupted (I1/I2) across ${res.reconstructions} reconstructions with no directory durability:\n${
              fmtFailures(res.failures)
            }`,
          );
        }
      });
    },
  );
};

sweepZeroDirDurability("PERSIST");
sweepZeroDirDurability("TRUNCATE");

const finalizationAb = (mode: JournalMode): void => {
  Deno.test(
    `journal_mode=${mode}: committed txn survives a DROPPED invalidation (A/B, zombie journal present)`,
    async () => {
      await withVfs(`jmode-ab-${mode}`, true, (sqlite3, recorder, dir) => {
        const spec: WorkloadSpec = {
          txns: 4,
          rowsPerTxn: 2,
          dbName: `/${mode.toLowerCase()}ab.db`,
        };
        let exercisedDangerous = 0;
        for (const seed of SEEDS) {
          const res = runFinalizationAb(sqlite3, recorder, dir, spec, mode, seed);
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
      });
    },
  );
};

finalizationAb("PERSIST");
finalizationAb("TRUNCATE");

const negativeControl = (mode: JournalMode): void => {
  Deno.test(
    `negative control journal_mode=${mode}: a lying no-op xSync is CAUGHT`,
    async () => {
      await withVfs(`jmode-noop-${mode}`, false, (sqlite3, recorder, dir) => {
        const res = runSweep(sqlite3, recorder, dir, {
          spec: {
            txns: 4,
            rowsPerTxn: 2,
            dbName: `/${mode.toLowerCase()}lie.db`,
            journalMode: mode,
          },
          seed: 424242,
          reconstructionsPerPoint: 8,
          dentryDurable: false,
        });
        assert(
          res.failures.length > 0,
          `${mode} harness FAILED to catch a broken xSync (recon=${res.reconstructions}) — it proves nothing`,
        );
        assert(
          res.failures.some((f) => f.detail.startsWith("I1")),
          `${mode}: expected at least one integrity (I1) failure from unsynced corruption`,
        );
      });
    },
  );
};

negativeControl("PERSIST");
negativeControl("TRUNCATE");

Deno.test(
  "baseline journal_mode=DELETE: the full sweep with ZERO directory durability STILL loses a committed txn (BUG-001 holds)",
  async () => {
    await withVfs("jmode-delete-baseline", true, (sqlite3, recorder, dir) => {
      let committedLoss = 0;
      for (const seed of SEEDS) {
        const res = runSweep(sqlite3, recorder, dir, {
          spec: { txns: 4, rowsPerTxn: 2, dbName: "/delete.db", journalMode: "DELETE" },
          seed,
          reconstructionsPerPoint: 8,
          dentryDurable: false,
        });
        committedLoss += res.failures.filter((f) => f.detail.includes("lost committed")).length;
      }
      assert(
        committedLoss > 0,
        "DELETE mode no longer loses a committed txn under zero directory durability — either a dir-fsync landed (re-adjudicate BUG-001) or the model stopped dropping the unlink dentry; do not silently relax it",
      );
    });
  },
);
