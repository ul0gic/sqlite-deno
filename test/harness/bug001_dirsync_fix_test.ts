import { assert, assertEquals } from "@std/assert";
import { loadSqlite3 } from "../../src/glue.ts";
import { installCrashVfs } from "./crash-vfs.ts";
import { runSweep } from "./sweep.ts";
import { journalDeleteIndices } from "./scenarios.ts";
import { reconstruct } from "./reconstruct.ts";
import { createRng } from "./rng.ts";
import { journalHasValidMagic } from "./journal_mode_durability.ts";
import { committedValuesAt, runWorkload, type WorkloadSpec } from "./workload.ts";
import { verifyReconstruction } from "./verify.ts";

const SEEDS = [1, 7, 1337, 90210, 2654435761] as const;
const isJournal = (file: string): boolean => file.endsWith("-journal");

const withVfs = async <T>(
  vfsName: string,
  realSync: boolean,
  dirSync: boolean,
  fn: (
    sqlite3: Awaited<ReturnType<typeof loadSqlite3>>,
    recorder: ReturnType<typeof installCrashVfs>,
    dir: string,
  ) => T | Promise<T>,
): Promise<T> => {
  const sqlite3 = await loadSqlite3();
  const recorder = installCrashVfs(sqlite3, { vfsName, realSync, dirSync });
  const dir = await Deno.makeTempDir({ prefix: "bug001fix-" });
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

Deno.test(
  "BUG-001 FIX: DELETE + synchronous=EXTRA + dir-sync survives the full crash sweep with ZERO implicit directory durability",
  async () => {
    await withVfs("bug001fix-delete-extra", true, true, (sqlite3, recorder, dir) => {
      for (const seed of SEEDS) {
        const spec: WorkloadSpec = {
          txns: 5,
          rowsPerTxn: 2,
          dbName: "/deleteextra.db",
          journalMode: "DELETE",
          synchronous: "EXTRA",
        };
        const res = runSweep(sqlite3, recorder, dir, {
          spec,
          seed,
          reconstructionsPerPoint: 8,
          dentryDurable: false,
        });
        assert(
          res.crashPoints > 20,
          `seed ${seed} swept too few crash points: ${res.crashPoints}`,
        );
        assertEquals(
          res.failures.length,
          0,
          `DELETE+EXTRA+dir-sync seed ${seed} LOST a committed txn or corrupted across ${res.reconstructions} reconstructions with no implicit directory durability:\n${
            fmtFailures(res.failures)
          }`,
        );
      }
    });
  },
);

Deno.test(
  "BUG-001 control: DELETE + EXTRA WITHOUT the dir-sync VFS still loses a committed txn (the fix, not the mode, is what closes T-B)",
  async () => {
    await withVfs("bug001fix-delete-nodirsync", true, false, (sqlite3, recorder, dir) => {
      let committedLoss = 0;
      for (const seed of SEEDS) {
        const res = runSweep(sqlite3, recorder, dir, {
          spec: {
            txns: 4,
            rowsPerTxn: 2,
            dbName: "/deletenofix.db",
            journalMode: "DELETE",
            synchronous: "EXTRA",
          },
          seed,
          reconstructionsPerPoint: 8,
          dentryDurable: false,
        });
        committedLoss += res.failures.filter((f) => f.detail.includes("lost committed")).length;
      }
      assert(
        committedLoss > 0,
        "DELETE without the dir-sync VFS no longer loses a committed txn under zero directory durability — the harness stopped dropping the unlink dentry; do not silently relax it",
      );
    });
  },
);

Deno.test(
  "BUG-001 FIX negative control: a lying no-op xSync (and lying dir-sync) under DELETE+EXTRA+dir-sync is CAUGHT",
  async () => {
    await withVfs("bug001fix-noop", false, true, (sqlite3, recorder, dir) => {
      const res = runSweep(sqlite3, recorder, dir, {
        spec: {
          txns: 4,
          rowsPerTxn: 2,
          dbName: "/deletelie.db",
          journalMode: "DELETE",
          synchronous: "EXTRA",
        },
        seed: 424242,
        reconstructionsPerPoint: 8,
        dentryDurable: false,
      });
      assert(
        res.failures.length > 0,
        `the dir-sync harness FAILED to catch a broken xSync (recon=${res.reconstructions}) — it proves nothing`,
      );
      assert(
        res.failures.some((f) => f.detail.startsWith("I1")),
        "expected at least one integrity (I1) failure from unsynced corruption",
      );
    });
  },
);

interface UnlinkAb {
  readonly crashIndex: number;
  readonly committed: readonly number[];
  readonly zombieJournalOnDisk: boolean;
  readonly withDirSyncOk: boolean;
  readonly withDirSyncPresent: readonly number[];
  readonly droppedDirSyncOk: boolean;
  readonly droppedDirSyncPresent: readonly number[];
}

const runUnlinkAb = (
  sqlite3: Awaited<ReturnType<typeof loadSqlite3>>,
  recorder: ReturnType<typeof installCrashVfs>,
  dir: string,
  seed: number,
): readonly UnlinkAb[] => {
  const recorded = runWorkload(sqlite3, recorder, {
    txns: 4,
    rowsPerTxn: 2,
    dbName: "/unlinkab.db",
    journalMode: "DELETE",
    synchronous: "EXTRA",
  });
  const issued = new Set<number>();
  for (const c of recorded.commits) issued.add(c.value);
  const out: UnlinkAb[] = [];

  for (const kDelete of journalDeleteIndices(recorded)) {
    const kDirSync = kDelete + 1;
    const opAfter = recorded.ops[kDelete];
    if (opAfter === undefined || opAfter.kind !== "dir-sync") continue;

    const committed = committedValuesAt(recorded.commits, kDirSync);
    if (committed.size === 0) continue;
    const subSeed = (seed * 1_000_003 + kDirSync * 131) >>> 0;

    const imgWith = reconstruct(recorded.ops, kDirSync, "drop-all-unsynced", createRng(subSeed), {
      dentryDurable: false,
    });
    const withRes = verifyReconstruction(
      sqlite3,
      dir,
      recorded.dbName,
      imgWith,
      committed,
      issued,
    );

    const opsNoDirSync = recorded.ops.filter((_, i) => i !== kDelete);
    const imgDropped = reconstruct(
      opsNoDirSync,
      kDelete,
      "drop-all-unsynced",
      createRng(subSeed),
      { dentryDurable: false },
    );
    const journalImg = [...imgDropped.entries()].find(([f]) => isJournal(f))?.[1];
    const zombie = journalImg?.exists === true && journalHasValidMagic(journalImg.bytes);
    const droppedRes = verifyReconstruction(
      sqlite3,
      dir,
      recorded.dbName,
      imgDropped,
      committed,
      issued,
    );

    out.push({
      crashIndex: kDirSync,
      committed: [...committed],
      zombieJournalOnDisk: zombie,
      withDirSyncOk: withRes.ok,
      withDirSyncPresent: [...withRes.present],
      droppedDirSyncOk: droppedRes.ok,
      droppedDirSyncPresent: [...droppedRes.present],
    });
  }
  return out;
};

Deno.test(
  "BUG-001 FIX A/B at the journal unlink: dir-sync issued -> committed survives; dir-sync dropped -> zombie resurrects and commit is lost",
  async () => {
    await withVfs("bug001fix-ab", true, true, (sqlite3, recorder, dir) => {
      let exercisedDangerous = 0;
      let provedFixMatters = 0;
      for (const seed of SEEDS) {
        const points = runUnlinkAb(sqlite3, recorder, dir, seed);
        assert(points.length > 0, `seed ${seed}: no journal-unlink A/B points with a commit`);
        for (const p of points) {
          assert(
            p.withDirSyncOk,
            `seed ${seed} k=${p.crashIndex}: A (unlink + dir-sync durable) lost committed [${p.committed}]; present=[${p.withDirSyncPresent}]`,
          );
          if (p.zombieJournalOnDisk) exercisedDangerous++;
          if (p.zombieJournalOnDisk && !p.droppedDirSyncOk) provedFixMatters++;
        }
      }
      assert(
        exercisedDangerous > 0,
        "the A/B never materialized a valid-header zombie journal — the dangerous case was not exercised, so the pass is vacuous",
      );
      assert(
        provedFixMatters > 0,
        "dropping the post-unlink dir-sync never produced a committed loss — the A/B did not isolate the dir-sync as the load-bearing fact; do not claim the fix",
      );
    });
  },
);
