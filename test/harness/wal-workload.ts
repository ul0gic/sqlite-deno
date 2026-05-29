import type { Sqlite3 } from "../../src/glue.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import type { Op } from "./oplog.ts";
import type { Synchronous } from "./workload.ts";
import { isWal } from "./wal-format.ts";

export interface WalCommit {
  readonly opIndex: number;
  readonly value: number;
  readonly walSyncCoveredOpIndex: number;
}

export interface RecordedWalWorkload {
  readonly ops: readonly Op[];
  readonly commits: readonly WalCommit[];
  readonly dbName: string;
  readonly synchronous: Synchronous;
}

export interface WalWorkloadSpec {
  readonly txns: number;
  readonly rowsPerTxn: number;
  readonly dbName: string;
  readonly synchronous: Synchronous;
}

const COMMIT_FRAME_NOT_YET_SYNCED = Number.MAX_SAFE_INTEGER;

/**
 * The op-index of the first `-wal` `xSync` at or after `commitOpIndex`. A WAL
 * commit's durability rests solely on a `-wal` sync covering its commit frame
 * (DEC-010 §2). At `FULL`/`EXTRA` SQLite syncs the `-wal` before acknowledging
 * the commit, so this index is `<= commitOpIndex`'s own returned point; at
 * `NORMAL` the covering sync may not arrive until a later commit or a
 * checkpoint, which is the §6 durability nuance the verifier keys on.
 */
const walSyncCoverageOf = (ops: readonly Op[], commitOpIndex: number): number => {
  for (let i = commitOpIndex; i < ops.length; i++) {
    const op = ops[i];
    if (op?.kind === "sync" && op.real && isWal(op.file)) return i + 1;
  }
  return COMMIT_FRAME_NOT_YET_SYNCED;
};

export const runWalWorkload = (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  spec: WalWorkloadSpec,
): RecordedWalWorkload => {
  recorder.reset();
  const rawCommits: { opIndex: number; value: number }[] = [];
  const db = new sqlite3.oo1.DB(spec.dbName, "c", recorder.name);
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE");
    const mode = db.selectValue("PRAGMA journal_mode=WAL");
    if (mode !== "wal") throw new Error(`expected journal_mode=wal, got ${String(mode)}`);
    db.exec(`PRAGMA synchronous=${spec.synchronous}`);
    db.exec("PRAGMA wal_autocheckpoint=0");
    db.exec("CREATE TABLE kv(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    let value = 1;
    for (let t = 0; t < spec.txns; t++) {
      db.exec("BEGIN");
      for (let r = 0; r < spec.rowsPerTxn; r++) {
        db.exec({ sql: "INSERT INTO kv(v) VALUES ($v)", bind: { $v: value } });
      }
      db.exec("COMMIT");
      rawCommits.push({ opIndex: recorder.ops.length, value });
      value++;
    }
  } finally {
    db.close();
  }

  const ops = [...recorder.ops];
  const commits = rawCommits.map((c) => ({
    opIndex: c.opIndex,
    value: c.value,
    walSyncCoveredOpIndex: walSyncCoverageOf(ops, c.opIndex),
  }));
  return { ops, commits, dbName: spec.dbName, synchronous: spec.synchronous };
};

export interface CommittedSets {
  readonly mustBePresent: ReadonlySet<number>;
  readonly mayBeAbsent: ReadonlySet<number>;
  readonly everIssued: ReadonlySet<number>;
}

/**
 * Partition the workload's values at crash index `k` per the `synchronous`
 * level (DEC-010 §6). A value is `mustBePresent` only if its COMMIT returned
 * before `k` AND a `-wal` sync covering its commit frame also occurred before
 * `k`. At `FULL`/`EXTRA` the covering sync precedes the commit's acknowledgement
 * so every returned COMMIT is required. At `NORMAL` a returned-but-not-yet-
 * `-wal`-synced commit is `mayBeAbsent` — a power-loss reconstruction may drop
 * it without an I2 violation. `everIssued` bounds the phantom check.
 */
export const committedSetsAt = (
  recorded: RecordedWalWorkload,
  k: number,
): CommittedSets => {
  const mustBePresent = new Set<number>();
  const mayBeAbsent = new Set<number>();
  const everIssued = new Set<number>();
  const strict = recorded.synchronous !== "NORMAL";
  for (const c of recorded.commits) {
    everIssued.add(c.value);
    if (c.opIndex > k) continue;
    const synced = c.walSyncCoveredOpIndex <= k;
    if (strict || synced) mustBePresent.add(c.value);
    else mayBeAbsent.add(c.value);
  }
  return { mustBePresent, mayBeAbsent, everIssued };
};
