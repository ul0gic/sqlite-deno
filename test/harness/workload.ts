import type { Sqlite3 } from "../../src/glue.ts";
import { openDatabaseWithVfs } from "../../src/database.ts";
import type { OpenOptions } from "../../src/database.ts";
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

export type CommitSink = (value: number) => void;

/**
 * Runs the bank-counter workload against the crash VFS and records the commit
 * boundaries. A driver owns *how* the SQL reaches the engine — directly via
 * `oo1.DB` (the engine floor) or through the public `Database` surface (the
 * shipped path). The recorded op stream feeds the reconstruct/sweep machinery,
 * which is driver-agnostic.
 */
export interface WorkloadDriver {
  readonly label: string;
  readonly write: (
    sqlite3: Sqlite3,
    recorder: CrashRecorder,
    spec: WorkloadSpec,
    onCommit: CommitSink,
  ) => void;
}

const writeViaEngine: WorkloadDriver["write"] = (sqlite3, recorder, spec, onCommit) => {
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
      onCommit(value);
      value++;
    }
  } finally {
    db.close();
  }
};

const runPublicApiTxns = (
  db: ReturnType<typeof openDatabaseWithVfs>,
  spec: WorkloadSpec,
  onCommit: CommitSink,
): void => {
  db.exec("CREATE TABLE kv(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  const insert = db.prepare("INSERT INTO kv(v) VALUES (?)");
  let value = 1;
  for (let t = 0; t < spec.txns; t++) {
    const tx = db.transaction();
    for (let r = 0; r < spec.rowsPerTxn; r++) insert.run(value);
    tx.commit();
    onCommit(value);
    value++;
  }
};

const writeViaPublicApiWith =
  (opts: OpenOptions): WorkloadDriver["write"] => (sqlite3, recorder, spec, onCommit) => {
    using db = openDatabaseWithVfs(sqlite3, spec.dbName, recorder.name, opts);
    runPublicApiTxns(db, spec, onCommit);
  };

/** Drives the workload's open/exec/commit straight through `oo1.DB` (engine floor). */
export const ENGINE_DRIVER: WorkloadDriver = { label: "engine", write: writeViaEngine };

/**
 * Drives the workload through the public surface at the **shipped rollback
 * default** (`durability: "full"`, BUG-004 fix): `openDatabase`'s seam runs
 * `journal_mode=PERSIST` + `synchronous=FULL`, and `Database.prepare`/`run` + the
 * savepoint `transaction()` carry the writes. The `spec`'s `journalMode`/
 * `synchronous` are ignored — the point is to prove the *shipped* envelope.
 */
export const PUBLIC_API_DRIVER: WorkloadDriver = {
  label: "public-api-full",
  write: writeViaPublicApiWith({ durability: "full" }),
};

/**
 * The public surface at the weaker opt-in `durability: "normal"`
 * (`synchronous=NORMAL`). Consistency-safe but may lose the latest committed txn
 * on power loss — the harness pins this so the weakness stays documented and
 * proven distinct from the durable default (BUG-004).
 */
export const PUBLIC_API_NORMAL_DRIVER: WorkloadDriver = {
  label: "public-api-normal",
  write: writeViaPublicApiWith({ durability: "normal" }),
};

export const runWorkload = (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  spec: WorkloadSpec,
  driver: WorkloadDriver = ENGINE_DRIVER,
): RecordedWorkload => {
  recorder.reset();
  const commits: Commit[] = [];
  driver.write(sqlite3, recorder, spec, (value) => {
    commits.push({ opIndex: recorder.ops.length, value });
  });
  return { ops: [...recorder.ops], commits, dbName: spec.dbName };
};

export const committedValuesAt = (commits: readonly Commit[], k: number): ReadonlySet<number> => {
  const set = new Set<number>();
  for (const c of commits) if (c.opIndex <= k) set.add(c.value);
  return set;
};
