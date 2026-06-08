import type { Sqlite3 } from "../../src/glue.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import { reconstruct } from "./reconstruct.ts";
import { createRng } from "./rng.ts";
import {
  committedValuesAt,
  type JournalMode,
  type RecordedWorkload,
  runWorkload,
  type WorkloadSpec,
} from "./workload.ts";
import { verifyReconstruction } from "./verify.ts";
import { journalHasValidMagic } from "../fixtures/crash_sweep_harness.ts";

export { journalHasValidMagic };

const isJournal = (file: string): boolean => file.endsWith("-journal");

/**
 * The commit-finalizing invalidation for a non-DELETE rollback mode: the journal
 * write@0 (PERSIST zeroes the header) or truncate-to-0 (TRUNCATE), occurring
 * immediately after a main-DB `xSync`. This is the analog of DELETE's `xDelete`
 * — the op whose durability decides whether a committed txn can be resurrected
 * by a zombie journal.
 */
export const finalizationIndices = (
  recorded: RecordedWorkload,
  mode: JournalMode,
): readonly number[] => {
  const ops = recorded.ops;
  const out: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const prev = i > 0 ? ops[i - 1] : undefined;
    if (op === undefined) continue;
    const prevIsMainSync = prev !== undefined && prev.kind === "sync" && !isJournal(prev.file);
    if (!prevIsMainSync) continue;
    if (mode === "PERSIST" && op.kind === "write" && isJournal(op.file) && op.offset === 0) {
      out.push(i + 1);
    }
    if (mode === "TRUNCATE" && op.kind === "truncate" && isJournal(op.file) && op.size === 0) {
      out.push(i + 1);
    }
  }
  return out;
};

const issuedValues = (recorded: RecordedWorkload): ReadonlySet<number> => {
  const issued = new Set<number>();
  for (const c of recorded.commits) issued.add(c.value);
  return issued;
};

export interface AbPoint {
  readonly crashIndex: number;
  readonly committed: readonly number[];
  readonly zombieJournalOnDisk: boolean;
  readonly durablePresent: readonly number[];
  readonly droppedPresent: readonly number[];
  readonly durableOk: boolean;
  readonly droppedOk: boolean;
  readonly droppedDetail: string;
}

export interface AbResult {
  readonly mode: JournalMode;
  readonly seed: number;
  readonly points: readonly AbPoint[];
}

/**
 * The differential, per commit finalization point: reconstruct with the
 * invalidation durable (dir durable) vs DROPPED (zero directory durability,
 * unsynced invalidation removed). `zombieJournalOnDisk` records whether the
 * dropped reconstruction actually materialized a valid-header journal — if it
 * did and the committed txn still survives, the survival is meaningful (the
 * dangerous case was exercised), not a vacuous pass.
 */
export const runFinalizationAb = async (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  dir: string,
  spec: WorkloadSpec,
  mode: JournalMode,
  seed: number,
): Promise<AbResult> => {
  const recorded = runWorkload(sqlite3, recorder, { ...spec, journalMode: mode });
  const issued = issuedValues(recorded);
  const points: AbPoint[] = [];

  for (const k of finalizationIndices(recorded, mode)) {
    const committed = committedValuesAt(recorded.commits, k);
    if (committed.size === 0) continue;

    const subSeed = (seed * 1_000_003 + k * 131) >>> 0;
    const imgDurable = reconstruct(recorded.ops, k, "apply-all-unsynced", createRng(subSeed), {
      dentryDurable: true,
    });
    const durable = await verifyReconstruction(
      sqlite3,
      dir,
      recorded.dbName,
      imgDurable,
      committed,
      issued,
    );

    const imgDropped = reconstruct(recorded.ops, k, "drop-all-unsynced", createRng(subSeed), {
      dentryDurable: false,
    });
    const journalImg = [...imgDropped.entries()].find(([f]) => isJournal(f))?.[1];
    const zombie = journalImg?.exists === true && journalHasValidMagic(journalImg.bytes);
    const dropped = await verifyReconstruction(
      sqlite3,
      dir,
      recorded.dbName,
      imgDropped,
      committed,
      issued,
    );

    points.push({
      crashIndex: k,
      committed: [...committed],
      zombieJournalOnDisk: zombie,
      durablePresent: [...durable.present],
      droppedPresent: [...dropped.present],
      durableOk: durable.ok,
      droppedOk: dropped.ok,
      droppedDetail: dropped.detail,
    });
  }

  return { mode, seed, points };
};
