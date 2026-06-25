import { basename, join } from "@std/path";
import type { Sqlite3 } from "../../src/glue.ts";
import { openDatabase } from "../../src/database.ts";
import { DENO_VFS_NAME, installDenoVfs } from "../../src/vfs/deno.ts";
import type { SqlValue } from "../../src/marshal.ts";
import type { FileImage } from "./oplog.ts";

export interface VerifyResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly present: ReadonlySet<number>;
}

// Owns *how* the reopen happens: engine floor (`oo1.DB`) vs the shipped
// `openDatabase` path, which runs recovery + the rollback pragma envelope.
export type ReadbackDriver = {
  readonly label: string;
  readonly readPresent: (sqlite3: Sqlite3, dbPath: string) => Set<number> | Promise<Set<number>>;
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
  const base = basename(dbName);
  const dbPath = join(dir, base);
  removeIfPresent(dbPath);
  removeIfPresent(`${dbPath}-journal`);
  for (const [file, img] of image) {
    if (!img.exists) continue;
    Deno.writeFileSync(localName(dir, file), img.bytes);
  }
  return dbPath;
};

const readPresentViaEngine = (sqlite3: Sqlite3, dbPath: string): Set<number> => {
  const present = new Set<number>();
  const db = new sqlite3.oo1.DB(dbPath, "c", DENO_VFS_NAME);
  try {
    const integrity = db.selectValue("PRAGMA integrity_check");
    if (integrity !== "ok") throw new Error(`integrity_check=${String(integrity)}`);
    const hasTable = db.selectValue(
      "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='kv'",
    );
    if (hasTable !== 1) return present;
    const rows = db.exec({
      sql: "SELECT v FROM kv ORDER BY v",
      rowMode: "array",
      returnValue: "resultRows",
    });
    for (const row of rows) {
      const v = Array.isArray(row) ? row[0] : undefined;
      if (typeof v !== "number") throw new Error(`torn row value: ${String(v)}`);
      present.add(v);
    }
  } finally {
    db.close();
  }
  return present;
};

const asNumber = (v: SqlValue): number => {
  if (typeof v !== "number") throw new Error(`expected integer, got ${String(v)}`);
  return v;
};

const readPresentViaPublicApi = async (_sqlite3: Sqlite3, dbPath: string): Promise<Set<number>> => {
  const present = new Set<number>();
  using db = await openDatabase(dbPath);
  const integrity = db.prepare<{ integrity_check: SqlValue }>("PRAGMA integrity_check").get();
  if (integrity?.integrity_check !== "ok") {
    throw new Error(`integrity_check=${String(integrity?.integrity_check)}`);
  }
  const tables = db.prepare<{ n: SqlValue }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='kv'",
  ).get();
  if (asNumber(tables?.n ?? 0) !== 1) return present;
  for (const row of db.prepare<{ v: SqlValue }>("SELECT v FROM kv ORDER BY v").all()) {
    present.add(asNumber(row.v));
  }
  return present;
};

export const ENGINE_READBACK: ReadbackDriver = {
  label: "engine",
  readPresent: readPresentViaEngine,
};

export const PUBLIC_API_READBACK: ReadbackDriver = {
  label: "public-api",
  readPresent: readPresentViaPublicApi,
};

export const verifyReconstruction = async (
  sqlite3: Sqlite3,
  dir: string,
  dbName: string,
  image: Map<string, FileImage>,
  committed: ReadonlySet<number>,
  issuedBeforeK: ReadonlySet<number>,
  driver: ReadbackDriver = ENGINE_READBACK,
): Promise<VerifyResult> => {
  installDenoVfs(sqlite3);
  const dbPath = materialize(dir, dbName, image);
  let present: Set<number>;
  try {
    present = await driver.readPresent(sqlite3, dbPath);
  } catch (e) {
    return {
      ok: false,
      detail: `I1 failed: ${e instanceof Error ? e.message : String(e)}`,
      present: new Set(),
    };
  }

  for (const v of committed) {
    if (!present.has(v)) {
      return {
        ok: false,
        detail: `I2 lost committed value ${v}; present=[${[...present].join(",")}]`,
        present,
      };
    }
  }
  for (const v of present) {
    if (!issuedBeforeK.has(v)) {
      return {
        ok: false,
        detail: `I2 phantom value ${v} never issued before crash; present=[${
          [...present].join(",")
        }]`,
        present,
      };
    }
  }
  return { ok: true, detail: "ok", present };
};
