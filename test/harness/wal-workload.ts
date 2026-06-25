import type { Sqlite3 } from "../../src/glue.ts";
import { openDatabaseWithVfs } from "../../src/database.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import type { Op } from "./oplog.ts";
import type { Synchronous } from "./workload.ts";
import type { ShapeStmt, WorkloadPlan } from "./workload-shape.ts";
import { buildWorkloadPlan } from "./workload-shape.ts";
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
  /** Mixes the seeded property workload over the `kv` markers; `kv` stays the I2 witness. */
  readonly shapeSeed?: number;
}

export type WalCommitSink = (value: number) => void;

export interface WalWorkloadDriver {
  readonly label: string;
  readonly write: (
    sqlite3: Sqlite3,
    recorder: CrashRecorder,
    spec: WalWorkloadSpec,
    onCommit: WalCommitSink,
  ) => void;
}

const planFor = (spec: WalWorkloadSpec): WorkloadPlan | undefined =>
  spec.shapeSeed === undefined ? undefined : buildWorkloadPlan(spec.shapeSeed);

type EngineDb = InstanceType<Sqlite3["oo1"]["DB"]>;

const runEngineStmt = (db: EngineDb, stmt: ShapeStmt): void => {
  if (stmt.kind === "exec") db.exec(stmt.sql);
  else db.exec({ sql: stmt.sql, bind: [...stmt.params] });
};

const writeViaEngine: WalWorkloadDriver["write"] = (sqlite3, recorder, spec, onCommit) => {
  const db = new sqlite3.oo1.DB(spec.dbName, "c", recorder.name);
  const plan = planFor(spec);
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE");
    const mode = db.selectValue("PRAGMA journal_mode=WAL");
    if (mode !== "wal") throw new Error(`expected journal_mode=wal, got ${String(mode)}`);
    db.exec(`PRAGMA synchronous=${spec.synchronous}`);
    db.exec("PRAGMA wal_autocheckpoint=0");
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

const durabilityOf = (sync: Synchronous): "normal" | "full" =>
  sync === "NORMAL" ? "normal" : "full";

type PublicDb = ReturnType<typeof openDatabaseWithVfs>;

const runPublicStmt = (db: PublicDb, stmt: ShapeStmt): void => {
  if (stmt.kind === "exec") {
    db.exec(stmt.sql);
    return;
  }
  using prepared = db.prepare(stmt.sql);
  prepared.run(...stmt.params);
};

const writeViaPublicApi: WalWorkloadDriver["write"] = (sqlite3, recorder, spec, onCommit) => {
  using db = openDatabaseWithVfs(sqlite3, spec.dbName, recorder.name, {
    mode: "wal",
    durability: durabilityOf(spec.synchronous),
  });
  const journal = db.prepare<{ journal_mode: string }>("PRAGMA journal_mode").get();
  if (journal?.journal_mode !== "wal") {
    throw new Error(
      `WAL did not engage through the public seam (journal_mode=${String(journal?.journal_mode)})`,
    );
  }
  db.exec("PRAGMA wal_autocheckpoint=0");
  db.exec("CREATE TABLE kv(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  const plan = planFor(spec);
  if (plan) { for (const s of plan.setup) runPublicStmt(db, s); }
  const insert = db.prepare("INSERT INTO kv(v) VALUES (?)");
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

export const ENGINE_WAL_DRIVER: WalWorkloadDriver = { label: "engine", write: writeViaEngine };

export const PUBLIC_API_WAL_DRIVER: WalWorkloadDriver = {
  label: "public-api",
  write: writeViaPublicApi,
};

const COMMIT_FRAME_NOT_YET_SYNCED = Number.MAX_SAFE_INTEGER;

// First `-wal` xSync at or after `commitOpIndex`: a WAL commit is durable only once
// its commit frame is `-wal`-synced (DEC-010 §2); at NORMAL that sync may lag the commit.
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
  driver: WalWorkloadDriver = ENGINE_WAL_DRIVER,
): RecordedWalWorkload => {
  recorder.reset();
  const rawCommits: { opIndex: number; value: number }[] = [];
  driver.write(sqlite3, recorder, spec, (value) => {
    rawCommits.push({ opIndex: recorder.ops.length, value });
  });

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

// Partition values at crash index `k` per `synchronous` (DEC-010 §6): at NORMAL a
// returned-but-not-yet-`-wal`-synced commit is `mayBeAbsent`, not required.
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
