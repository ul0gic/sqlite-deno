import type { Sqlite3 } from "../../src/glue.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import type { Op } from "./oplog.ts";

export interface Commit {
  readonly opIndex: number;
  readonly value: number;
}

export interface RecordedWorkload {
  readonly ops: readonly Op[];
  readonly commits: readonly Commit[];
  readonly dbName: string;
}

export const JOURNAL_MODES = ["DELETE", "PERSIST", "TRUNCATE"] as const;
export type JournalMode = (typeof JOURNAL_MODES)[number];

export const SYNCHRONOUS = ["NORMAL", "FULL", "EXTRA"] as const;
export type Synchronous = (typeof SYNCHRONOUS)[number];

export interface WorkloadSpec {
  readonly txns: number;
  readonly rowsPerTxn: number;
  readonly dbName: string;
  readonly journalMode?: JournalMode;
  /**
   * `PRAGMA synchronous`. EXTRA is the level at which SQLite sets `extraSync`
   * and so passes `syncDir=1` to `xDelete` of the `-journal` (pager.c
   * `extraSync` is set only for `PAGER_SYNCHRONOUS_EXTRA`). That commit-point
   * directory fsync is the os_unix.c step the dir-sync VFS variant honors.
   */
  readonly synchronous?: Synchronous;
}

export const runWorkload = (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  spec: WorkloadSpec,
): RecordedWorkload => {
  recorder.reset();
  const commits: Commit[] = [];
  const db = new sqlite3.oo1.DB(spec.dbName, "c", recorder.name);
  try {
    db.exec(`PRAGMA journal_mode=${spec.journalMode ?? "DELETE"}`);
    if (spec.synchronous !== undefined) db.exec(`PRAGMA synchronous=${spec.synchronous}`);
    db.exec("CREATE TABLE kv(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    let value = 1;
    for (let t = 0; t < spec.txns; t++) {
      db.exec("BEGIN");
      for (let r = 0; r < spec.rowsPerTxn; r++) {
        db.exec({ sql: "INSERT INTO kv(v) VALUES ($v)", bind: { $v: value } });
      }
      db.exec("COMMIT");
      commits.push({ opIndex: recorder.ops.length, value });
      value++;
    }
  } finally {
    db.close();
  }
  return { ops: [...recorder.ops], commits, dbName: spec.dbName };
};

export const committedValuesAt = (commits: readonly Commit[], k: number): ReadonlySet<number> => {
  const set = new Set<number>();
  for (const c of commits) if (c.opIndex <= k) set.add(c.value);
  return set;
};
