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
  /**
   * When set, mixes the same seeded property-generated op space the rollback
   * sweep uses (`workload-shape.ts` — a hostile auxiliary table touched by
   * UPDATE/DELETE inside each marker txn, plus VACUUM between txns) on top of the
   * `kv` marker inserts. `kv` stays the durable witness the WAL I2 oracle reads
   * back, so the committed-set invariant remains checkable while the WAL sweep
   * covers more than sequential single-column inserts. VACUUM-in-WAL must engage
   * through our VFS with no `-shm` and `iVersion==1` (DEC-010).
   */
  readonly shapeSeed?: number;
}

export type WalCommitSink = (value: number) => void;

/**
 * Owns *how* the WAL workload reaches the engine — directly via `oo1.DB` with the
 * hand-written `locking_mode=EXCLUSIVE`/`journal_mode=WAL` pragma sequence (the
 * engine floor), or through the public `openDatabaseWithVfs` seam at
 * `{ mode: "wal", durability }` (the shipped path). Either way the driver must
 * leave WAL engaged with no `-shm` on disk; the recording and sync-coverage
 * machinery downstream is driver-agnostic.
 */
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

/** Drives the WAL workload straight through `oo1.DB` (engine floor). */
export const ENGINE_WAL_DRIVER: WalWorkloadDriver = { label: "engine", write: writeViaEngine };

/**
 * Drives the WAL workload through the public `openDatabaseWithVfs` seam at
 * `{ mode: "wal", durability }` (durability maps from the spec's `synchronous`):
 * the shipped envelope runs `locking_mode=EXCLUSIVE` + `journal_mode=WAL` +
 * `synchronous`, and `Database.prepare`/`run` + the savepoint `transaction()`
 * carry the writes. Proves WAL recovery over the literal shipped surface.
 */
export const PUBLIC_API_WAL_DRIVER: WalWorkloadDriver = {
  label: "public-api",
  write: writeViaPublicApi,
};

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
