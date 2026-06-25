import { basename as pathBasename, join } from "@std/path";
import type { Sqlite3 } from "../../src/glue.ts";
import { openDatabase } from "../../src/database.ts";
import { DENO_VFS_NAME, installDenoVfs } from "../../src/vfs/deno.ts";
import type { SqlValue } from "../../src/marshal.ts";
import type { FileImage } from "./oplog.ts";
import type { CommittedSets } from "./wal-workload.ts";

export interface WalVerifyResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly present: ReadonlySet<number>;
}

export type WalReadbackDriver = {
  readonly label: string;
  readonly readPresent: (sqlite3: Sqlite3, dbPath: string) => Set<number> | Promise<Set<number>>;
};

const baseName = (file: string): string => pathBasename(file);

const removeIfPresent = (path: string): void => {
  try {
    Deno.removeSync(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
};

const materialize = (
  dir: string,
  dbName: string,
  image: Map<string, FileImage>,
): string => {
  const base = baseName(dbName);
  const dbPath = join(dir, base);
  removeIfPresent(dbPath);
  removeIfPresent(`${dbPath}-wal`);
  removeIfPresent(`${dbPath}-shm`);
  removeIfPresent(`${dbPath}-journal`);
  for (const [file, img] of image) {
    if (!img.exists) continue;
    Deno.writeFileSync(join(dir, baseName(file)), img.bytes);
  }
  return dbPath;
};

const readPresentViaEngine = (sqlite3: Sqlite3, dbPath: string): Set<number> => {
  const present = new Set<number>();
  const db = new sqlite3.oo1.DB(dbPath, "w", DENO_VFS_NAME);
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE");
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
  if (typeof v !== "number") throw new Error(`torn row value: ${String(v)}`);
  return v;
};

const readPresentViaPublicApi = async (
  _sqlite3: Sqlite3,
  dbPath: string,
): Promise<Set<number>> => {
  const present = new Set<number>();
  using db = await openDatabase(dbPath, { mode: "wal" });
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

export const ENGINE_WAL_READBACK: WalReadbackDriver = {
  label: "engine",
  readPresent: readPresentViaEngine,
};

export const PUBLIC_API_WAL_READBACK: WalReadbackDriver = {
  label: "public-api",
  readPresent: readPresentViaPublicApi,
};

const checkInvariants = (present: ReadonlySet<number>, sets: CommittedSets): WalVerifyResult => {
  for (const v of sets.mustBePresent) {
    if (!present.has(v)) {
      return {
        ok: false,
        detail: `I2 lost durable committed value ${v}; present=[${[...present].join(",")}]`,
        present,
      };
    }
  }
  for (const v of present) {
    if (!sets.everIssued.has(v)) {
      return {
        ok: false,
        detail: `I2 phantom value ${v} never issued; present=[${[...present].join(",")}]`,
        present,
      };
    }
  }
  return { ok: true, detail: "ok", present };
};

// I3: `assertShmIrrelevant` re-recovers the same image with a stray `-shm` planted;
// an identical value set proves recovery rebuilds the wal-index from `-wal` alone (DEC-010 §6).
export const verifyWalReconstruction = async (
  sqlite3: Sqlite3,
  dir: string,
  dbName: string,
  image: Map<string, FileImage>,
  sets: CommittedSets,
  opts: {
    readonly assertShmIrrelevant?: boolean;
    readonly readbackDriver?: WalReadbackDriver;
  } = {},
): Promise<WalVerifyResult> => {
  const assertShmIrrelevant = opts.assertShmIrrelevant ?? false;
  const driver = opts.readbackDriver ?? ENGINE_WAL_READBACK;
  installDenoVfs(sqlite3);
  const dbPath = materialize(dir, dbName, image);
  const shmPath = `${dbPath}-shm`;
  if (existsSync(shmPath)) {
    return { ok: false, detail: `I3 image materialized a -shm (${shmPath})`, present: new Set() };
  }

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

  const base = checkInvariants(present, sets);
  if (!base.ok || !assertShmIrrelevant) return base;

  Deno.writeFileSync(shmPath, new Uint8Array(SHM_STRAY_SIZE));
  let withShm: Set<number>;
  try {
    withShm = await driver.readPresent(sqlite3, dbPath);
  } catch (e) {
    return {
      ok: false,
      detail: `I3 reopen with stray -shm failed: ${e instanceof Error ? e.message : String(e)}`,
      present,
    };
  } finally {
    removeIfPresent(shmPath);
  }
  if (!setsEqual(present, withShm)) {
    return {
      ok: false,
      detail: `I3 stray -shm changed recovery: without=[${[...present]}] with=[${[...withShm]}]`,
      present,
    };
  }
  return base;
};

const SHM_STRAY_SIZE = 32768;

const existsSync = (path: string): boolean => {
  try {
    Deno.statSync(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
};

const setsEqual = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
};
