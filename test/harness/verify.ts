import type { Sqlite3 } from "../../src/glue.ts";
import { DENO_VFS_NAME, installDenoVfs } from "../../src/vfs/deno.ts";
import type { FileImage } from "./oplog.ts";

export interface VerifyResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly present: ReadonlySet<number>;
}

const localName = (dir: string, file: string): string => `${dir}/${file.replace(/^.*\//, "")}`;

const removeIfPresent = (path: string): void => {
  try {
    Deno.removeSync(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
};

const materialize = (dir: string, dbName: string, image: Map<string, FileImage>): string => {
  const base = dbName.replace(/^.*\//, "");
  const dbPath = `${dir}/${base}`;
  removeIfPresent(dbPath);
  removeIfPresent(`${dbPath}-journal`);
  for (const [file, img] of image) {
    if (!img.exists) continue;
    Deno.writeFileSync(localName(dir, file), img.bytes);
  }
  return dbPath;
};

const readPresent = (sqlite3: Sqlite3, dbPath: string): Set<number> => {
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

export const verifyReconstruction = (
  sqlite3: Sqlite3,
  dir: string,
  dbName: string,
  image: Map<string, FileImage>,
  committed: ReadonlySet<number>,
  issuedBeforeK: ReadonlySet<number>,
): VerifyResult => {
  installDenoVfs(sqlite3);
  const dbPath = materialize(dir, dbName, image);
  let present: Set<number>;
  try {
    present = readPresent(sqlite3, dbPath);
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
