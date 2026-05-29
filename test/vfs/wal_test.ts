import { assert, assertEquals } from "@std/assert";
import { loadSqlite3, type Sqlite3 } from "../../src/glue.ts";
import { DENO_VFS_NAME, installDenoVfs } from "../../src/vfs/deno.ts";

type DB = InstanceType<Sqlite3["oo1"]["DB"]>;

const SQLITE_FCNTL_FILE_POINTER = 7;

const existsSync = (path: string): boolean => {
  try {
    Deno.statSync(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
};

const sizeOf = (path: string): number => Deno.statSync(path).size;

const withVfs = async (
  fn: (sqlite3: Sqlite3, dir: string) => void | Promise<void>,
): Promise<void> => {
  const sqlite3 = await loadSqlite3();
  installDenoVfs(sqlite3);
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-wal-" });
  try {
    await fn(sqlite3, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const openWal = (sqlite3: Sqlite3, path: string, flags: "c" | "w"): DB => {
  const db = new sqlite3.oo1.DB(path, flags, DENO_VFS_NAME);
  db.exec("PRAGMA locking_mode=EXCLUSIVE");
  return db;
};

const enterWal = (db: DB): unknown => db.selectValue("PRAGMA journal_mode=WAL");

const integrityOk = (db: DB): boolean => db.selectValue("PRAGMA integrity_check") === "ok";

const rowCount = (db: DB, table: string): unknown =>
  db.selectValue(`SELECT count(*) FROM ${table}`);

interface CheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

const checkpoint = (db: DB, mode: string): CheckpointResult => {
  const rows = db.exec({
    sql: `PRAGMA wal_checkpoint(${mode})`,
    rowMode: "array",
    returnValue: "resultRows",
  });
  const row = rows[0];
  assert(row !== undefined, `wal_checkpoint(${mode}) returned no row`);
  const [busy, log, checkpointed] = row;
  assert(
    typeof busy === "number" && typeof log === "number" && typeof checkpointed === "number",
    `wal_checkpoint(${mode}) row was not a numeric triple: ${JSON.stringify(row)}`,
  );
  return { busy, log, checkpointed };
};

const ioMethodsVersionOf = (sqlite3: Sqlite3, db: DB): number => {
  const pDb = db.pointer;
  assert(pDb !== undefined, "the database connection has no wasm pointer");
  const { wasm, capi } = sqlite3;
  const stack = wasm.pstack.pointer;
  try {
    const ppFile = wasm.pstack.alloc(4);
    const fcRc = capi.sqlite3_file_control(pDb, "main", SQLITE_FCNTL_FILE_POINTER, ppFile);
    assertEquals(fcRc, capi.SQLITE_OK);
    const pFile = Number(wasm.peek32(ppFile));
    assert(pFile !== 0, "SQLITE_FCNTL_FILE_POINTER yielded a null sqlite3_file*");
    const pMethods = Number(wasm.peek32(pFile));
    assert(pMethods !== 0, "the open file had no io-methods vtable");
    return Number(wasm.peek32(pMethods));
  } finally {
    wasm.pstack.restore(stack);
  }
};

Deno.test("exclusive-mode WAL round-trips rows across many transactions and reopens", async () => {
  await withVfs((sqlite3, dir) => {
    const path = `${dir}/wal-roundtrip.db`;
    const writer = openWal(sqlite3, path, "c");
    try {
      assertEquals(enterWal(writer), "wal");
      writer.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
      for (let i = 0; i < 50; i++) {
        writer.exec("BEGIN");
        writer.exec({ sql: "INSERT INTO t(v) VALUES (?)", bind: [`row-${i}`] });
        writer.exec("COMMIT");
      }
      assertEquals(rowCount(writer, "t"), 50);
      assert(integrityOk(writer));
    } finally {
      writer.close();
    }
    const reader = openWal(sqlite3, path, "w");
    try {
      assertEquals(enterWal(reader), "wal");
      assertEquals(rowCount(reader, "t"), 50);
      assertEquals(reader.selectValue("SELECT v FROM t WHERE id = 1"), "row-0");
      assertEquals(reader.selectValue("SELECT v FROM t WHERE id = 50"), "row-49");
      assert(integrityOk(reader));
    } finally {
      reader.close();
    }
  });
});

Deno.test("no -shm is created at any point in the WAL lifecycle", async () => {
  await withVfs((sqlite3, dir) => {
    const path = `${dir}/no-shm.db`;
    const shm = `${path}-shm`;
    const db = openWal(sqlite3, path, "c");
    try {
      assertEquals(enterWal(db), "wal");
      db.exec("CREATE TABLE t(v INTEGER)");
      db.exec("INSERT INTO t(v) VALUES (1)");
      assertEquals(existsSync(shm), false);
      db.exec("BEGIN");
      db.exec("INSERT INTO t(v) VALUES (2)");
      assertEquals(existsSync(shm), false);
      db.exec("COMMIT");
      assertEquals(existsSync(shm), false);
      checkpoint(db, "TRUNCATE");
      assertEquals(existsSync(shm), false);
    } finally {
      db.close();
    }
    assertEquals(existsSync(shm), false);
  });
});

Deno.test("the live WAL connection's io-methods are iVersion 1, so no xShm slot exists", async () => {
  await withVfs((sqlite3, dir) => {
    const path = `${dir}/iversion.db`;
    const db = openWal(sqlite3, path, "c");
    try {
      assertEquals(enterWal(db), "wal");
      db.exec("CREATE TABLE t(v INTEGER)");
      db.exec("INSERT INTO t(v) VALUES (1)");
      assertEquals(ioMethodsVersionOf(sqlite3, db), 1);
    } finally {
      db.close();
    }
  });
});

Deno.test("-wal exists while WAL is active and is zeroed by checkpoint(TRUNCATE)", async () => {
  await withVfs((sqlite3, dir) => {
    const path = `${dir}/wal-lifecycle.db`;
    const wal = `${path}-wal`;
    const db = openWal(sqlite3, path, "c");
    try {
      assertEquals(enterWal(db), "wal");
      db.exec("CREATE TABLE t(v INTEGER)");
      db.exec("INSERT INTO t(v) VALUES (1), (2), (3)");
      assert(existsSync(wal), "the -wal must exist while WAL is active");
      assert(sizeOf(wal) > 0, "the -wal must carry frames before checkpoint");
      checkpoint(db, "TRUNCATE");
      assert(!existsSync(wal) || sizeOf(wal) === 0, "checkpoint(TRUNCATE) must zero the -wal");
      assertEquals(rowCount(db, "t"), 3);
      assert(integrityOk(db));
    } finally {
      db.close();
    }
  });
});

Deno.test("WAL without exclusive locking falls back to rollback, creating neither -wal nor -shm", async () => {
  await withVfs((sqlite3, dir) => {
    const path = `${dir}/fallback.db`;
    const db = new sqlite3.oo1.DB(path, "c", DENO_VFS_NAME);
    try {
      assertEquals(db.selectValue("PRAGMA journal_mode=WAL"), "delete");
      db.exec("CREATE TABLE t(v INTEGER)");
      db.exec("INSERT INTO t(v) VALUES (1)");
      assertEquals(rowCount(db, "t"), 1);
      assertEquals(existsSync(`${path}-wal`), false);
      assertEquals(existsSync(`${path}-shm`), false);
      assert(integrityOk(db));
    } finally {
      db.close();
    }
  });
});

Deno.test("every checkpoint mode returns a sane non-busy triple and leaves the db intact", async () => {
  await withVfs((sqlite3, dir) => {
    const path = `${dir}/checkpoint-modes.db`;
    const db = openWal(sqlite3, path, "c");
    try {
      assertEquals(enterWal(db), "wal");
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
      for (const mode of ["PASSIVE", "FULL", "RESTART", "TRUNCATE"]) {
        db.exec({ sql: "INSERT INTO t(v) VALUES (?)", bind: [`before-${mode}`] });
        const r = checkpoint(db, mode);
        assertEquals(
          r.busy,
          0,
          `checkpoint(${mode}) reported busy under a single exclusive connection`,
        );
        assert(r.log >= 0 && r.checkpointed >= 0, `checkpoint(${mode}) returned a negative count`);
        assert(r.checkpointed <= r.log, `checkpoint(${mode}) checkpointed more frames than logged`);
        assert(integrityOk(db), `integrity_check failed after checkpoint(${mode})`);
        assertEquals(existsSync(`${path}-shm`), false);
      }
      assertEquals(rowCount(db, "t"), 4);
    } finally {
      db.close();
    }
  });
});

Deno.test("checkpoint(TRUNCATE) reports zero remaining frames once the wal is fully drained", async () => {
  await withVfs((sqlite3, dir) => {
    const path = `${dir}/truncate-drain.db`;
    const db = openWal(sqlite3, path, "c");
    try {
      assertEquals(enterWal(db), "wal");
      db.exec("CREATE TABLE t(v INTEGER)");
      db.exec("INSERT INTO t(v) VALUES (1), (2), (3)");
      const r = checkpoint(db, "TRUNCATE");
      assertEquals(r.busy, 0);
      assertEquals(r.log, 0);
      assertEquals(r.checkpointed, 0);
      assert(integrityOk(db));
    } finally {
      db.close();
    }
  });
});
