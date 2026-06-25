import type { Sqlite3 } from "../../src/glue.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import { isMutatingOp } from "./oplog.ts";
import { createRng } from "./rng.ts";
import { committedSetsAt } from "./wal-workload.ts";
import type { Synchronous } from "./workload.ts";
import { reconstructWal, WAL_VARIANTS } from "./wal-reconstruct.ts";
import { verifyWalReconstruction } from "./wal-verify.ts";
import type { WalCommit } from "./wal-workload.ts";
import { isWal } from "./wal-format.ts";

export const CHECKPOINT_MODES = ["PASSIVE", "FULL", "RESTART", "TRUNCATE"] as const;
export type CheckpointMode = (typeof CHECKPOINT_MODES)[number];

export interface CheckpointCrashConfig {
  readonly dbName: string;
  readonly mode: CheckpointMode;
  readonly preCommits: number;
  readonly postCommits: number;
  readonly seed: number;
  readonly reconstructionsPerPoint: number;
}

export interface CheckpointCrashFailure {
  readonly crashIndex: number;
  readonly phase: "checkpoint" | "post-checkpoint";
  readonly content: string;
  readonly tail: string;
  readonly detail: string;
}

export interface CheckpointCrashResult {
  readonly mode: CheckpointMode;
  readonly checkpointCrashPoints: number;
  readonly reconstructions: number;
  readonly failures: readonly CheckpointCrashFailure[];
}

const SYNC: Synchronous = "FULL";

interface RecordedCheckpointRun {
  readonly ops: CrashRecorder["ops"];
  readonly commits: readonly WalCommit[];
  readonly checkpointStart: number;
  readonly checkpointEnd: number;
}

const walSyncCoverageOf = (ops: CrashRecorder["ops"], from: number): number => {
  for (let i = from; i < ops.length; i++) {
    const op = ops[i];
    if (op?.kind === "sync" && op.real && isWal(op.file)) return i + 1;
  }
  return Number.MAX_SAFE_INTEGER;
};

const driveCheckpointRun = (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  cfg: CheckpointCrashConfig,
): RecordedCheckpointRun => {
  recorder.reset();
  const rawCommits: { opIndex: number; value: number }[] = [];
  const db = new sqlite3.oo1.DB(cfg.dbName, "c", recorder.name);
  let checkpointStart = 0;
  let checkpointEnd = 0;
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE");
    if (db.selectValue("PRAGMA journal_mode=WAL") !== "wal") throw new Error("WAL not entered");
    db.exec(`PRAGMA synchronous=${SYNC}`);
    db.exec("PRAGMA wal_autocheckpoint=0");
    db.exec("CREATE TABLE kv(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    let value = 1;
    const commit = (): void => {
      db.exec("BEGIN");
      db.exec({ sql: "INSERT INTO kv(v) VALUES ($v)", bind: { $v: value } });
      db.exec("COMMIT");
      rawCommits.push({ opIndex: recorder.ops.length, value });
      value++;
    };
    for (let t = 0; t < cfg.preCommits; t++) commit();
    checkpointStart = recorder.ops.length;
    db.exec(`PRAGMA wal_checkpoint(${cfg.mode})`);
    checkpointEnd = recorder.ops.length;
    for (let t = 0; t < cfg.postCommits; t++) commit();
  } finally {
    db.close();
  }
  const ops = [...recorder.ops];
  const commits = rawCommits.map((c) => ({
    opIndex: c.opIndex,
    value: c.value,
    walSyncCoveredOpIndex: walSyncCoverageOf(ops, c.opIndex),
  }));
  return { ops, commits, checkpointStart, checkpointEnd };
};

// Post-checkpoint commits exercise the RESTART/TRUNCATE salt-advance guard:
// an advanced salt blocks stale pre-reset frame replay, which I1/I2 would catch (DEC-010 §5).
export const runCheckpointCrash = async (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  dir: string,
  cfg: CheckpointCrashConfig,
): Promise<CheckpointCrashResult> => {
  const run = driveCheckpointRun(sqlite3, recorder, cfg);
  const recorded = { ops: run.ops, commits: run.commits, dbName: cfg.dbName, synchronous: SYNC };
  const failures: CheckpointCrashFailure[] = [];
  let reconstructions = 0;
  let checkpointCrashPoints = 0;

  for (let k = run.checkpointStart + 1; k <= run.ops.length; k++) {
    const op = run.ops[k - 1];
    if (op === undefined || !isMutatingOp(op)) continue;
    checkpointCrashPoints++;
    const phase = k <= run.checkpointEnd ? "checkpoint" : "post-checkpoint";
    const sets = committedSetsAt(recorded, k);
    for (let i = 0; i < cfg.reconstructionsPerPoint; i++) {
      const variant = WAL_VARIANTS[i % WAL_VARIANTS.length];
      if (variant === undefined) continue;
      const subSeed = (cfg.seed * 2_246_822_519 + k * 97 + i) >>> 0;
      const rng = createRng(subSeed);
      const { image } = reconstructWal(run.ops, k, variant.content, variant.tail, rng);
      const result = await verifyWalReconstruction(sqlite3, dir, cfg.dbName, image, sets);
      reconstructions++;
      if (!result.ok) {
        failures.push({
          crashIndex: k,
          phase,
          content: variant.content,
          tail: variant.tail,
          detail: result.detail,
        });
      }
    }
  }

  return { mode: cfg.mode, checkpointCrashPoints, reconstructions, failures };
};
