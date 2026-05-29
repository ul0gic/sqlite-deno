import type { Sqlite3 } from "../../src/glue.ts";
import { DENO_VFS_NAME, installDenoVfs } from "../../src/vfs/deno.ts";
import type { FileImage } from "./oplog.ts";
import type { CommittedSets } from "./wal-workload.ts";

export interface WalVerifyResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly present: ReadonlySet<number>;
}

const baseName = (file: string): string => file.replace(/^.*\//, "");

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
  const dbPath = `${dir}/${base}`;
  removeIfPresent(dbPath);
  removeIfPresent(`${dbPath}-wal`);
  removeIfPresent(`${dbPath}-shm`);
  removeIfPresent(`${dbPath}-journal`);
  for (const [file, img] of image) {
    if (!img.exists) continue;
    Deno.writeFileSync(`${dir}/${baseName(file)}`, img.bytes);
  }
  return dbPath;
};

const readPresent = (sqlite3: Sqlite3, dbPath: string): Set<number> => {
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

/**
 * Materialize a reconstructed WAL image, reopen it through the real Deno-FS VFS
 * in exclusive WAL mode, and assert I1 (`integrity_check=ok`) and I2 (every
 * `mustBePresent` value survives, no phantom). `mayBeAbsent` values are neither
 * required nor forbidden (the `synchronous=NORMAL` nuance, DEC-010 §6).
 *
 * I3: the materialized image carries no `-shm`; recovery rebuilds the heap
 * wal-index from the `-wal` alone. When `assertShmIrrelevant` is set, the same
 * image is recovered a second time with a stray `-shm` planted before reopen —
 * the recovered value set must be identical, proving the `-shm` is a pure cache.
 */
export const verifyWalReconstruction = (
  sqlite3: Sqlite3,
  dir: string,
  dbName: string,
  image: Map<string, FileImage>,
  sets: CommittedSets,
  opts: { readonly assertShmIrrelevant: boolean } = { assertShmIrrelevant: false },
): WalVerifyResult => {
  installDenoVfs(sqlite3);
  const dbPath = materialize(dir, dbName, image);
  const shmPath = `${dbPath}-shm`;
  if (existsSync(shmPath)) {
    return { ok: false, detail: `I3 image materialized a -shm (${shmPath})`, present: new Set() };
  }

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

  const base = checkInvariants(present, sets);
  if (!base.ok || !opts.assertShmIrrelevant) return base;

  Deno.writeFileSync(shmPath, new Uint8Array(SHM_STRAY_SIZE));
  let withShm: Set<number>;
  try {
    withShm = readPresent(sqlite3, dbPath);
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
