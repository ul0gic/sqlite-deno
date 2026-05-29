import { assert, assertEquals } from "@std/assert";
import { loadSqlite3 } from "../../src/glue.ts";
import { DENO_VFS_NAME, installDenoVfs } from "../../src/vfs/deno.ts";

const withDb = async <T>(
  fn: (sqlite3: Awaited<ReturnType<typeof loadSqlite3>>, dir: string) => T | Promise<T>,
): Promise<T> => {
  const sqlite3 = await loadSqlite3();
  installDenoVfs(sqlite3);
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-fs-" });
  try {
    return await fn(sqlite3, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

Deno.test("installDenoVfs registers the file-backed VFS", async () => {
  const sqlite3 = await loadSqlite3();
  assertEquals(installDenoVfs(sqlite3), DENO_VFS_NAME);
  assert(sqlite3.capi.sqlite3_vfs_find(DENO_VFS_NAME) !== 0);
});

Deno.test("installDenoVfs is idempotent", async () => {
  const sqlite3 = await loadSqlite3();
  installDenoVfs(sqlite3);
  assertEquals(installDenoVfs(sqlite3), DENO_VFS_NAME);
});

Deno.test("CREATE/INSERT/SELECT round-trips through a real file on disk", async () => {
  await withDb((sqlite3, dir) => {
    const db = new sqlite3.oo1.DB(`${dir}/roundtrip.db`, "c", DENO_VFS_NAME);
    try {
      db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)");
      db.exec("INSERT INTO users(id, name) VALUES (1, 'alice'), (2, 'bob')");
      const rows = db.exec({
        sql: "SELECT id, name FROM users ORDER BY id",
        rowMode: "object",
        returnValue: "resultRows",
      });
      assertEquals(rows, [{ id: 1, name: "alice" }, { id: 2, name: "bob" }]);
      assertEquals(db.selectValue("SELECT count(*) FROM users"), 2);
    } finally {
      db.close();
    }
    assert(Deno.statSync(`${dir}/roundtrip.db`).size > 0);
  });
});

Deno.test("data survives close and reopen of the same file", async () => {
  await withDb((sqlite3, dir) => {
    const path = `${dir}/persist.db`;
    const first = new sqlite3.oo1.DB(path, "c", DENO_VFS_NAME);
    try {
      first.exec("CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT)");
      first.exec("INSERT INTO kv(k, v) VALUES ('greeting', 'hello')");
    } finally {
      first.close();
    }
    const second = new sqlite3.oo1.DB(path, "c", DENO_VFS_NAME);
    try {
      assertEquals(second.selectValue("SELECT v FROM kv WHERE k = 'greeting'"), "hello");
    } finally {
      second.close();
    }
  });
});

Deno.test("a transaction creates a -journal and removes it on commit", async () => {
  await withDb((sqlite3, dir) => {
    const path = `${dir}/txn.db`;
    const journal = `${path}-journal`;
    const db = new sqlite3.oo1.DB(path, "c", DENO_VFS_NAME);
    try {
      db.exec("CREATE TABLE n(v INTEGER)");
      db.exec("INSERT INTO n(v) VALUES (1)");
      db.exec("BEGIN");
      db.exec("INSERT INTO n(v) VALUES (2)");
      assertEquals(Deno.statSync(journal).isFile, true);
      db.exec("COMMIT");
      assertEquals(db.selectValue("SELECT count(*) FROM n"), 2);
    } finally {
      db.close();
    }
    assertEquals(existsSync(journal), false);
  });
});

Deno.test("a rolled-back transaction leaves committed rows intact", async () => {
  await withDb((sqlite3, dir) => {
    const db = new sqlite3.oo1.DB(`${dir}/rollback.db`, "c", DENO_VFS_NAME);
    try {
      db.exec("CREATE TABLE n(v INTEGER)");
      db.exec("INSERT INTO n(v) VALUES (1)");
      db.exec("BEGIN");
      db.exec("INSERT INTO n(v) VALUES (2)");
      db.exec("ROLLBACK");
      assertEquals(db.selectValue("SELECT count(*) FROM n"), 1);
      assertEquals(db.selectValue("SELECT v FROM n"), 1);
    } finally {
      db.close();
    }
  });
});

Deno.test("a row larger than one page round-trips through file I/O", async () => {
  await withDb((sqlite3, dir) => {
    const db = new sqlite3.oo1.DB(`${dir}/blob.db`, "c", DENO_VFS_NAME);
    const payload = "x".repeat(64 * 1024);
    try {
      db.exec("CREATE TABLE big(id INTEGER PRIMARY KEY, body TEXT)");
      const stmt = db.prepare("INSERT INTO big(body) VALUES (?)");
      try {
        stmt.bind(payload).stepReset();
      } finally {
        stmt.finalize();
      }
      assertEquals(db.selectValue("SELECT length(body) FROM big"), payload.length);
      assertEquals(db.selectValue("SELECT body FROM big"), payload);
    } finally {
      db.close();
    }
  });
});

const existsSync = (path: string): boolean => {
  try {
    Deno.statSync(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
};
