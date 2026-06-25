import { basename, join } from "@std/path";
import type { Sqlite3 } from "../../src/glue.ts";
import { openDatabase } from "../../src/database.ts";
import { DENO_VFS_NAME, installDenoVfs } from "../../src/vfs/deno.ts";
import type { SqlValue } from "../../src/marshal.ts";
import type { FileImage } from "./oplog.ts";
import type { Cell, DbState, Row } from "./freeform-model.ts";
import { acceptableStatesAt, stateMismatch } from "./freeform-model.ts";
import type { TableSchema } from "./freeform-schema.ts";
import type { RecordedFreeForm } from "./freeform-workload.ts";

export interface FreeFormVerifyResult {
  readonly ok: boolean;
  readonly detail: string;
}

export type FreeFormReadbackDriver = {
  readonly label: string;
  readonly read: (
    sqlite3: Sqlite3,
    dbPath: string,
    tables: readonly TableSchema[],
  ) => DbState | Promise<DbState>;
};

const localName = (dir: string, file: string): string => join(dir, basename(file));

const removeIfPresent = (path: string): void => {
  try {
    Deno.removeSync(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
};

const materialize = (dir: string, dbName: string, image: Map<string, FileImage>): string => {
  const dbPath = join(dir, basename(dbName));
  removeIfPresent(dbPath);
  removeIfPresent(`${dbPath}-journal`);
  removeIfPresent(`${dbPath}-wal`);
  removeIfPresent(`${dbPath}-shm`);
  for (const [file, img] of image) {
    if (!img.exists) continue;
    Deno.writeFileSync(localName(dir, file), img.bytes);
  }
  return dbPath;
};

const selectSql = (t: TableSchema): string =>
  `SELECT id, ${t.columns.join(", ")} FROM ${t.name} ORDER BY id`;

const asId = (v: SqlValue): number => {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(`non-numeric primary key ${String(v)}`);
};

const rowFrom = (raw: readonly SqlValue[]): { id: number; cells: Row } => {
  const [first, ...rest] = raw;
  if (first === undefined) throw new Error("empty result row");
  return { id: asId(first), cells: rest as Cell[] };
};

const readViaEngine = (
  sqlite3: Sqlite3,
  dbPath: string,
  tables: readonly TableSchema[],
  mode: "rollback" | "wal",
): DbState => {
  const out = new Map<string, Map<number, Row>>();
  const db = new sqlite3.oo1.DB(dbPath, "w", DENO_VFS_NAME);
  try {
    if (mode === "wal") db.exec("PRAGMA locking_mode=EXCLUSIVE");
    const integrity = db.selectValue("PRAGMA integrity_check");
    if (integrity !== "ok") throw new Error(`integrity_check=${String(integrity)}`);
    for (const t of tables) {
      const table = new Map<number, Row>();
      const exists = db.selectValue(
        `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='${t.name}'`,
      );
      if (exists === 1) {
        const rows = db.exec({ sql: selectSql(t), rowMode: "array", returnValue: "resultRows" });
        for (const raw of rows) {
          if (!Array.isArray(raw)) throw new Error("expected array row");
          const { id, cells } = rowFrom(raw as SqlValue[]);
          table.set(id, cells);
        }
      }
      out.set(t.name, table);
    }
  } finally {
    db.close();
  }
  return out;
};

const readViaPublicApi = async (
  _sqlite3: Sqlite3,
  dbPath: string,
  tables: readonly TableSchema[],
  mode: "rollback" | "wal",
): Promise<DbState> => {
  const out = new Map<string, Map<number, Row>>();
  using db = await openDatabase(dbPath, mode === "wal" ? { mode: "wal" } : {});
  const integrity = db.prepare<{ integrity_check: SqlValue }>("PRAGMA integrity_check").get();
  if (integrity?.integrity_check !== "ok") {
    throw new Error(`integrity_check=${String(integrity?.integrity_check)}`);
  }
  for (const t of tables) {
    const table = new Map<number, Row>();
    const exists = db.prepare<{ n: SqlValue }>(
      `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='${t.name}'`,
    ).get();
    if (Number(exists?.n ?? 0) === 1) {
      for (const raw of db.prepare<readonly SqlValue[]>(selectSql(t)).all()) {
        const { id, cells } = rowFrom(Array.isArray(raw) ? raw : Object.values(raw));
        table.set(id, cells);
      }
    }
    out.set(t.name, table);
  }
  return out;
};

export const engineFreeFormReadback = (mode: "rollback" | "wal"): FreeFormReadbackDriver => ({
  label: "engine",
  read: (sqlite3, dbPath, tables) => readViaEngine(sqlite3, dbPath, tables, mode),
});

export const publicFreeFormReadback = (mode: "rollback" | "wal"): FreeFormReadbackDriver => ({
  label: "public-api",
  read: (sqlite3, dbPath, tables) => readViaPublicApi(sqlite3, dbPath, tables, mode),
});

export const verifyFreeForm = async (
  sqlite3: Sqlite3,
  dir: string,
  recorded: RecordedFreeForm,
  image: Map<string, FileImage>,
  k: number,
  driver: FreeFormReadbackDriver,
): Promise<FreeFormVerifyResult> => {
  installDenoVfs(sqlite3);
  const dbPath = materialize(dir, recorded.dbName, image);
  let actual: DbState;
  try {
    actual = await driver.read(sqlite3, dbPath, recorded.schema.tables);
  } catch (e) {
    return { ok: false, detail: `I1 failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const strict = recorded.durability === "full";
  const candidates = acceptableStatesAt(recorded.snapshots, k, strict);
  for (const expected of candidates) {
    if (stateMismatch(expected, actual) === null) return { ok: true, detail: "ok" };
  }
  const closest = candidates[0];
  const m = closest ? stateMismatch(closest, actual) : null;
  return {
    ok: false,
    detail: `I2 ${m?.table ?? "?"}: ${m?.detail ?? "no acceptable committed state matched"}`,
  };
};
