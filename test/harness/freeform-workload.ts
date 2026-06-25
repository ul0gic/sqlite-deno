import type { Sqlite3 } from "../../src/glue.ts";
import { openDatabaseWithVfs } from "../../src/database.ts";
import type { OpenOptions } from "../../src/database.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import type { Op } from "./oplog.ts";
import { isWal } from "./wal-format.ts";
import type { CommitSnapshot, ReferenceModel } from "./freeform-model.ts";
import { createReferenceModel } from "./freeform-model.ts";
import type { FreeFormOp, GeneratedSchema, GeneratedWorkload } from "./freeform-schema.ts";

export type Mode = "rollback" | "wal";
export type Durability = "normal" | "full";

export interface FreeFormSpec {
  readonly workload: GeneratedWorkload;
  readonly dbName: string;
  readonly mode: Mode;
  readonly durability: Durability;
}

export interface RecordedFreeForm {
  readonly ops: readonly Op[];
  readonly snapshots: readonly CommitSnapshot[];
  readonly schema: GeneratedSchema;
  readonly opLabels: readonly string[];
  readonly dbName: string;
  readonly mode: Mode;
  readonly durability: Durability;
}

interface LiveDriver {
  readonly run: (op: FreeFormOp) => void;
  readonly close: () => void;
}

export interface FreeFormDriver {
  readonly label: string;
  readonly open: (
    sqlite3: Sqlite3,
    recorder: CrashRecorder,
    spec: FreeFormSpec,
  ) => LiveDriver;
}

const opParams = (op: FreeFormOp): readonly (number | bigint | string | Uint8Array | null)[] => {
  if (op.kind === "insert" || op.kind === "update") return [...op.cells, op.id];
  if (op.kind === "delete") return [op.id];
  return [];
};

const insertParams = (
  op: Extract<FreeFormOp, { kind: "insert" }>,
): readonly (number | bigint | string | Uint8Array | null)[] => [op.id, ...op.cells];

const labelOf = (op: FreeFormOp): string => {
  if (op.kind === "insert") return `INSERT ${op.table} id=${op.id}`;
  if (op.kind === "update") return `UPDATE ${op.table} id=${op.id}`;
  if (op.kind === "delete") return `DELETE ${op.table} id=${op.id}`;
  if (op.kind === "savepoint") return `SAVEPOINT ${op.name}`;
  if (op.kind === "release") return `RELEASE ${op.name}`;
  if (op.kind === "rollback-to") return `ROLLBACK TO ${op.name}`;
  return op.kind.toUpperCase();
};

type EngineDb = InstanceType<Sqlite3["oo1"]["DB"]>;

const controlSql = (op: FreeFormOp): string | null => {
  switch (op.kind) {
    case "begin":
      return "BEGIN";
    case "commit":
      return "COMMIT";
    case "rollback":
      return "ROLLBACK";
    case "vacuum":
      return "VACUUM";
    case "savepoint":
      return `SAVEPOINT ${op.name}`;
    case "release":
      return `RELEASE ${op.name}`;
    case "rollback-to":
      return `ROLLBACK TO ${op.name}`;
    default:
      return null;
  }
};

const enterRollback = (db: EngineDb, durability: Durability): void => {
  db.exec("PRAGMA journal_mode=PERSIST");
  db.exec(`PRAGMA synchronous=${durability === "full" ? "FULL" : "NORMAL"}`);
};

const enterWal = (db: EngineDb, durability: Durability): void => {
  db.exec("PRAGMA locking_mode=EXCLUSIVE");
  const mode = db.selectValue("PRAGMA journal_mode=WAL");
  if (mode !== "wal") throw new Error(`expected journal_mode=wal, got ${String(mode)}`);
  db.exec(`PRAGMA synchronous=${durability === "full" ? "FULL" : "NORMAL"}`);
  db.exec("PRAGMA wal_autocheckpoint=0");
};

const engineDriver: FreeFormDriver = {
  label: "engine",
  open: (sqlite3, recorder, spec) => {
    const db = new sqlite3.oo1.DB(spec.dbName, "c", recorder.name);
    if (spec.mode === "wal") enterWal(db, spec.durability);
    else enterRollback(db, spec.durability);
    for (const ddl of spec.workload.schema.ddl) db.exec(ddl);
    return {
      run: (op) => {
        const sql = controlSql(op);
        if (sql !== null) {
          db.exec(sql);
          return;
        }
        if (op.kind === "insert") {
          db.exec({ sql: op.sql, bind: [...insertParams(op)] });
          return;
        }
        if (op.kind === "update" || op.kind === "delete") {
          db.exec({ sql: op.sql, bind: [...opParams(op)] });
        }
      },
      close: () => db.close(),
    };
  },
};

const publicOpts = (spec: FreeFormSpec): OpenOptions =>
  spec.mode === "wal"
    ? { mode: "wal", durability: spec.durability }
    : { mode: "rollback", durability: spec.durability };

const publicDriver: FreeFormDriver = {
  label: "public-api",
  open: (sqlite3, recorder, spec) => {
    const db = openDatabaseWithVfs(sqlite3, spec.dbName, recorder.name, publicOpts(spec));
    if (spec.mode === "wal") {
      const journal = db.prepare<{ journal_mode: string }>("PRAGMA journal_mode").get();
      if (journal?.journal_mode !== "wal") {
        throw new Error(
          `WAL did not engage through the seam (got ${String(journal?.journal_mode)})`,
        );
      }
      db.exec("PRAGMA wal_autocheckpoint=0");
    }
    for (const ddl of spec.workload.schema.ddl) db.exec(ddl);
    return {
      run: (op) => {
        const sql = controlSql(op);
        if (sql !== null) {
          db.exec(sql);
          return;
        }
        if (op.kind === "insert") {
          using stmt = db.prepare(op.sql);
          stmt.run(...insertParams(op));
          return;
        }
        if (op.kind === "update" || op.kind === "delete") {
          using stmt = db.prepare(op.sql);
          stmt.run(...opParams(op));
        }
      },
      close: () => db[Symbol.dispose](),
    };
  },
};

export const ENGINE_FREEFORM_DRIVER = engineDriver;
export const PUBLIC_FREEFORM_DRIVER = publicDriver;

const applyToModel = (model: ReferenceModel, op: FreeFormOp, opIndex: number): void => {
  switch (op.kind) {
    case "insert":
      model.insert(op.table, op.id, op.cells);
      return;
    case "update":
      model.update(op.table, op.id, op.cells);
      return;
    case "delete":
      model.del(op.table, op.id);
      return;
    case "begin":
      model.begin(opIndex);
      return;
    case "rollback":
      model.rollback();
      return;
    case "savepoint":
      model.savepoint();
      return;
    case "release":
      model.release();
      return;
    case "rollback-to":
      model.rollbackTo();
      return;
    default:
      return;
  }
};

const walSyncCoverageOf = (ops: readonly Op[], commitOpIndex: number): number => {
  for (let i = commitOpIndex; i < ops.length; i++) {
    const op = ops[i];
    if (op?.kind === "sync" && op.real && isWal(op.file)) return i + 1;
  }
  return Number.MAX_SAFE_INTEGER;
};

export const runFreeFormWorkload = (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  spec: FreeFormSpec,
  driver: FreeFormDriver,
): RecordedFreeForm => {
  recorder.reset();
  const model = createReferenceModel(spec.workload.schema.tables.map((t) => t.name));
  const live = driver.open(sqlite3, recorder, spec);
  const opLabels: string[] = [];
  try {
    for (const op of spec.workload.ops) {
      live.run(op);
      opLabels.push(labelOf(op));
      if (op.kind === "commit") model.commit(recorder.ops.length);
      else applyToModel(model, op, recorder.ops.length);
    }
  } finally {
    live.close();
  }

  const ops = [...recorder.ops];
  const snapshots = model.snapshots();
  if (spec.mode === "wal") {
    for (const s of snapshots) s.walSyncCoveredOpIndex = walSyncCoverageOf(ops, s.opIndex);
  }

  return {
    ops,
    snapshots: [...snapshots],
    schema: spec.workload.schema,
    opLabels,
    dbName: spec.dbName,
    mode: spec.mode,
    durability: spec.durability,
  };
};
