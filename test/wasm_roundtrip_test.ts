import { assert, assertEquals } from "@std/assert";
import { loadSqlite3 } from "../src/glue.ts";
import { installMemoryVfs, MEMORY_VFS_NAME } from "../src/vfs/memory.ts";

Deno.test("loads the vendored wasm and reports SQLite 3.53.0", async () => {
  const sqlite3 = await loadSqlite3();
  assertEquals(sqlite3.capi.sqlite3_libversion(), "3.53.0");
});

Deno.test("installVfs registers the in-memory VFS against the prebuilt wasm", async () => {
  const sqlite3 = await loadSqlite3();
  const name = installMemoryVfs(sqlite3);
  assertEquals(name, MEMORY_VFS_NAME);
  assert(sqlite3.capi.sqlite3_vfs_find(name) !== 0);
});

Deno.test("installVfs is idempotent for an already-registered VFS", async () => {
  const sqlite3 = await loadSqlite3();
  installMemoryVfs(sqlite3);
  assertEquals(installMemoryVfs(sqlite3), MEMORY_VFS_NAME);
});

Deno.test("CREATE/INSERT/SELECT round-trips through the in-memory VFS", async () => {
  const sqlite3 = await loadSqlite3();
  installMemoryVfs(sqlite3);
  const db = new sqlite3.oo1.DB("/roundtrip.db", "c", MEMORY_VFS_NAME);
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
});

Deno.test("data survives a close/reopen of the same VFS-backed file", async () => {
  const sqlite3 = await loadSqlite3();
  installMemoryVfs(sqlite3);
  const path = "/persist.db";
  const first = new sqlite3.oo1.DB(path, "c", MEMORY_VFS_NAME);
  try {
    first.exec("CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT)");
    first.exec("INSERT INTO kv(k, v) VALUES ('greeting', 'hello')");
  } finally {
    first.close();
  }
  const second = new sqlite3.oo1.DB(path, "c", MEMORY_VFS_NAME);
  try {
    assertEquals(second.selectValue("SELECT v FROM kv WHERE k = 'greeting'"), "hello");
  } finally {
    second.close();
  }
});

Deno.test("a transaction rolls back without corrupting committed rows", async () => {
  const sqlite3 = await loadSqlite3();
  installMemoryVfs(sqlite3);
  const db = new sqlite3.oo1.DB("/txn.db", "c", MEMORY_VFS_NAME);
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
