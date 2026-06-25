import type { Sqlite3 } from "../../src/glue.ts";
import { openDatabaseWithVfs } from "../../src/database.ts";
import type { OpenOptions } from "../../src/database.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import type { Op } from "./oplog.ts";
import type { ShapeStmt, WorkloadPlan } from "./workload-shape.ts";
import { buildWorkloadPlan } from "./workload-shape.ts";

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
  // Only EXTRA sets pager.c `extraSync`, passing `syncDir=1` to the `-journal`
  // xDelete — the commit-point dir fsync the dir-sync VFS variant honors.
  readonly synchronous?: Synchronous;
  // `kv` stays the durable witness the I2 oracle reads back; the seed only mixes
  // a hostile auxiliary op space on top, keeping the committed-set check valid.
  readonly shapeSeed?: number;
}

export type CommitSink = (value: number) => void;

export interface WorkloadDriver {
  readonly label: string;
  readonly write: (
    sqlite3: Sqlite3,
    recorder: CrashRecorder,
    spec: WorkloadSpec,
    onCommit: CommitSink,
  ) => void;
}

const planFor = (spec: WorkloadSpec): WorkloadPlan | undefined =>
  spec.shapeSeed === undefined ? undefined : buildWorkloadPlan(spec.shapeSeed);

type EngineDb = InstanceType<Sqlite3["oo1"]["DB"]>;

const runEngineStmt = (db: EngineDb, stmt: ShapeStmt): void => {
  if (stmt.kind === "exec") db.exec(stmt.sql);
  else db.exec({ sql: stmt.sql, bind: [...stmt.params] });
};

const writeViaEngine: WorkloadDriver["write"] = (sqlite3, recorder, spec, onCommit) => {
  const db = new sqlite3.oo1.DB(spec.dbName, "c", recorder.name);
  const plan = planFor(spec);
  try {
    db.exec(`PRAGMA journal_mode=${spec.journalMode ?? "DELETE"}`);
    if (spec.synchronous !== undefined) db.exec(`PRAGMA synchronous=${spec.synchronous}`);
    db.exec("CREATE TABLE kv(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    if (plan) { for (const s of plan.setup) runEngineStmt(db, s); }
    let value = 1;
    for (let t = 0; t < spec.txns; t++) {
      if (plan) { for (const s of plan.betweenTxn(t)) runEngineStmt(db, s); }
      db.exec("BEGIN");
      for (let r = 0; r < spec.rowsPerTxn; r++) {
        db.exec({ sql: "INSERT INTO kv(v) VALUES ($v)", bind: { $v: value } });
      }
      if (plan) { for (const s of plan.perTxn(t)) runEngineStmt(db, s); }
      db.exec("COMMIT");
      onCommit(value);
      value++;
    }
  } finally {
    db.close();
  }
};

type PublicDb = ReturnType<typeof openDatabaseWithVfs>;

const runPublicStmt = (db: PublicDb, stmt: ShapeStmt): void => {
  if (stmt.kind === "exec") {
    db.exec(stmt.sql);
    return;
  }
  using prepared = db.prepare(stmt.sql);
  prepared.run(...stmt.params);
};

const runPublicApiTxns = (
  db: PublicDb,
  spec: WorkloadSpec,
  onCommit: CommitSink,
): void => {
  const plan = planFor(spec);
  db.exec("CREATE TABLE kv(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  if (plan) { for (const s of plan.setup) runPublicStmt(db, s); }
  using insert = db.prepare("INSERT INTO kv(v) VALUES (?)");
  let value = 1;
  for (let t = 0; t < spec.txns; t++) {
    if (plan) { for (const s of plan.betweenTxn(t)) runPublicStmt(db, s); }
    const tx = db.transaction();
    for (let r = 0; r < spec.rowsPerTxn; r++) insert.run(value);
    if (plan) { for (const s of plan.perTxn(t)) runPublicStmt(db, s); }
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

export const ENGINE_DRIVER: WorkloadDriver = { label: "engine", write: writeViaEngine };

// Shipped rollback default proving the durable envelope; spec journalMode/
// synchronous are ignored here, the seam pins PERSIST + FULL (BUG-004).
export const PUBLIC_API_DRIVER: WorkloadDriver = {
  label: "public-api-full",
  write: writeViaPublicApiWith({ durability: "full" }),
};

// Weaker opt-in `durability: "normal"`: consistency-safe but may lose the last
// committed txn on power loss — pinned distinct from the durable default (BUG-004).
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
