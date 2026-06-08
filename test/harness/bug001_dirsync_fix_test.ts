import { assert, assertEquals } from "@std/assert";
import type { loadSqlite3 } from "../../src/glue.ts";
import type { installCrashVfs } from "./crash-vfs.ts";
import { journalDeleteIndices } from "./scenarios.ts";
import { reconstruct } from "./reconstruct.ts";
import { createRng } from "./rng.ts";
import { committedValuesAt, runWorkload } from "./workload.ts";
import { verifyReconstruction } from "./verify.ts";
import {
  commitLossFailures,
  fmtFailures,
  integrityFailures,
  journalHasValidMagic,
  runMatrixSweep,
  SWEEP_SEEDS,
  withSweepVfs,
} from "../fixtures/crash_sweep_harness.ts";

const isJournal = (file: string): boolean => file.endsWith("-journal");

Deno.test(
  "BUG-001 FIX: DELETE + synchronous=EXTRA + dir-sync survives the full crash sweep with ZERO implicit directory durability",
  async () => {
    const res = await runMatrixSweep({
      cell: { journalMode: "DELETE", synchronous: "EXTRA", dirSync: true, dentryDurable: false },
      txns: 5,
      rowsPerTxn: 2,
      dbName: "/deleteextra.db",
      seeds: SWEEP_SEEDS,
      reconstructionsPerPoint: 8,
      vfsName: "bug001fix-delete-extra",
    });
    assert(res.crashPoints > 20, `swept too few crash points: ${res.crashPoints}`);
    assertEquals(
      res.failures.length,
      0,
      `DELETE+EXTRA+dir-sync LOST a committed txn or corrupted across ${res.reconstructions} reconstructions with no implicit directory durability:\n${
        fmtFailures(res.failures)
      }`,
    );
  },
);

Deno.test(
  "BUG-001 control: DELETE + EXTRA WITHOUT the dir-sync VFS still loses a committed txn (the fix, not the mode, is what closes T-B)",
  async () => {
    const res = await runMatrixSweep({
      cell: { journalMode: "DELETE", synchronous: "EXTRA", dirSync: false, dentryDurable: false },
      txns: 4,
      rowsPerTxn: 2,
      dbName: "/deletenofix.db",
      seeds: SWEEP_SEEDS,
      reconstructionsPerPoint: 8,
      vfsName: "bug001fix-delete-nodirsync",
    });
    assert(
      commitLossFailures(res.failures).length > 0,
      "DELETE without the dir-sync VFS no longer loses a committed txn under zero directory durability — the harness stopped dropping the unlink dentry; do not silently relax it",
    );
  },
);

Deno.test(
  "BUG-001 FIX negative control: a lying no-op xSync (and lying dir-sync) under DELETE+EXTRA+dir-sync is CAUGHT",
  async () => {
    const res = await runMatrixSweep({
      cell: { journalMode: "DELETE", synchronous: "EXTRA", dirSync: true, dentryDurable: false },
      txns: 4,
      rowsPerTxn: 2,
      dbName: "/deletelie.db",
      seeds: [424242],
      reconstructionsPerPoint: 8,
      realSync: false,
      vfsName: "bug001fix-noop",
    });
    assert(
      res.failures.length > 0,
      `the dir-sync harness FAILED to catch a broken xSync (recon=${res.reconstructions}) — it proves nothing`,
    );
    assert(
      integrityFailures(res.failures).length > 0,
      "expected at least one integrity (I1) failure from unsynced corruption",
    );
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

const runUnlinkAb = async (
  sqlite3: Awaited<ReturnType<typeof loadSqlite3>>,
  recorder: ReturnType<typeof installCrashVfs>,
  dir: string,
  seed: number,
): Promise<readonly UnlinkAb[]> => {
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
    const withRes = await verifyReconstruction(
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
    const droppedRes = await verifyReconstruction(
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
    await withSweepVfs(
      { vfsName: "bug001fix-ab", realSync: true, dirSync: true, tempPrefix: "bug001fix-" },
      async ({ sqlite3, recorder, dir }) => {
        let exercisedDangerous = 0;
        let provedFixMatters = 0;
        for (const seed of SWEEP_SEEDS) {
          const points = await runUnlinkAb(sqlite3, recorder, dir, seed);
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
      },
    );
  },
);
