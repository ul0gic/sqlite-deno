import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { loadSqlite3 } from "../src/glue.ts";
import {
  SqliteBusyError,
  SqliteCantOpenError,
  SqliteConstraintError,
  SqliteCorruptError,
  SqliteError,
  SqliteMisuseError,
  SqliteRangeError,
  SqliteReadonlyError,
  toSqliteError,
} from "../src/errors.ts";
import type { DbPtr } from "../src/wasm/ptr.ts";

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_CORRUPT = 11;
const SQLITE_CANTOPEN = 14;
const SQLITE_CONSTRAINT = 19;
const SQLITE_MISUSE = 21;
const SQLITE_RANGE = 25;
const SQLITE_NOTADB = 26;
const SQLITE_NOMEM = 7;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_NOTNULL = 1299;
const SQLITE_READONLY_DIRECTORY = 1544;

Deno.test("SqliteError carries code, extendedCode, and message", async () => {
  const sqlite3 = await loadSqlite3();
  const err = toSqliteError(SQLITE_BUSY, sqlite3);
  assertInstanceOf(err, SqliteError);
  assertEquals(err.code, SQLITE_BUSY);
  assertEquals(err.extendedCode, SQLITE_BUSY);
  assert(err.message.length > 0);
});

Deno.test("every subclass is an instanceof SqliteError and Error", async () => {
  const sqlite3 = await loadSqlite3();
  const cases: readonly [number, abstract new (...a: never[]) => SqliteError][] = [
    [SQLITE_BUSY, SqliteBusyError],
    [SQLITE_CONSTRAINT, SqliteConstraintError],
    [SQLITE_CANTOPEN, SqliteCantOpenError],
    [SQLITE_READONLY, SqliteReadonlyError],
    [SQLITE_CORRUPT, SqliteCorruptError],
    [SQLITE_RANGE, SqliteRangeError],
    [SQLITE_MISUSE, SqliteMisuseError],
  ];
  for (const [rc, ctor] of cases) {
    const err = toSqliteError(rc, sqlite3);
    assertInstanceOf(err, ctor);
    assertInstanceOf(err, SqliteError);
    assertInstanceOf(err, Error);
  }
});

Deno.test("BUSY and LOCKED both map to SqliteBusyError", async () => {
  const sqlite3 = await loadSqlite3();
  assertInstanceOf(toSqliteError(SQLITE_BUSY, sqlite3), SqliteBusyError);
  assertInstanceOf(toSqliteError(SQLITE_LOCKED, sqlite3), SqliteBusyError);
});

Deno.test("NOTADB maps to SqliteCorruptError alongside CORRUPT", async () => {
  const sqlite3 = await loadSqlite3();
  assertInstanceOf(toSqliteError(SQLITE_CORRUPT, sqlite3), SqliteCorruptError);
  assertInstanceOf(toSqliteError(SQLITE_NOTADB, sqlite3), SqliteCorruptError);
});

Deno.test("extended codes mask to the primary subclass and retain the extended code", async () => {
  const sqlite3 = await loadSqlite3();
  const unique = toSqliteError(SQLITE_CONSTRAINT_UNIQUE, sqlite3);
  assertInstanceOf(unique, SqliteConstraintError);
  assertEquals(unique.code, SQLITE_CONSTRAINT);
  assertEquals(unique.extendedCode, SQLITE_CONSTRAINT_UNIQUE);

  const notnull = toSqliteError(SQLITE_CONSTRAINT_NOTNULL, sqlite3);
  assertInstanceOf(notnull, SqliteConstraintError);
  assertEquals(notnull.extendedCode, SQLITE_CONSTRAINT_NOTNULL);

  const roDir = toSqliteError(SQLITE_READONLY_DIRECTORY, sqlite3);
  assertInstanceOf(roDir, SqliteReadonlyError);
  assertEquals(roDir.code, SQLITE_READONLY);
  assertEquals(roDir.extendedCode, SQLITE_READONLY_DIRECTORY);
});

Deno.test("an unmapped primary code falls through to the base SqliteError", async () => {
  const sqlite3 = await loadSqlite3();
  const err = toSqliteError(SQLITE_NOMEM, sqlite3);
  assertEquals(err.constructor, SqliteError);
  assertEquals(err.code, SQLITE_NOMEM);
  assertEquals(err.name, "SqliteError");
});

Deno.test("name is set on the base class and every subclass", async () => {
  const sqlite3 = await loadSqlite3();
  assertEquals(toSqliteError(SQLITE_NOMEM, sqlite3).name, "SqliteError");
  assertEquals(toSqliteError(SQLITE_BUSY, sqlite3).name, "SqliteBusyError");
  assertEquals(toSqliteError(SQLITE_CONSTRAINT, sqlite3).name, "SqliteConstraintError");
  assertEquals(toSqliteError(SQLITE_CANTOPEN, sqlite3).name, "SqliteCantOpenError");
  assertEquals(toSqliteError(SQLITE_READONLY, sqlite3).name, "SqliteReadonlyError");
  assertEquals(toSqliteError(SQLITE_CORRUPT, sqlite3).name, "SqliteCorruptError");
  assertEquals(toSqliteError(SQLITE_RANGE, sqlite3).name, "SqliteRangeError");
  assertEquals(toSqliteError(SQLITE_MISUSE, sqlite3).name, "SqliteMisuseError");
});

Deno.test("a real UNIQUE violation classifies through the db handle", async () => {
  const sqlite3 = await loadSqlite3();
  const db = new sqlite3.oo1.DB(":memory:", "c");
  try {
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT UNIQUE)");
    db.exec("INSERT INTO t(id, email) VALUES (1, 'a@b.c')");
    const ptr = db.pointer;
    assert(typeof ptr === "number");
    // Reinterpret the upstream WasmPointer as our branded db handle — the one
    // boundary cast for an external sqlite3* the ABI gives us as a bare number.
    const handle = ptr as DbPtr;
    try {
      db.exec("INSERT INTO t(id, email) VALUES (2, 'a@b.c')");
    } catch {
      // The throw is expected; the handle now carries the failing rc.
    }
    const classified = toSqliteError(SQLITE_CONSTRAINT, sqlite3, handle);
    assertInstanceOf(classified, SqliteConstraintError);
    assertEquals(classified.code, SQLITE_CONSTRAINT);
    assertEquals(classified.extendedCode, SQLITE_CONSTRAINT_UNIQUE);
    assert(classified.message.length > 0);
  } finally {
    db.close();
  }
});

Deno.test("the db-handle message comes from sqlite3_errmsg, not the static errstr", async () => {
  const sqlite3 = await loadSqlite3();
  const db = new sqlite3.oo1.DB(":memory:", "c");
  try {
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    const ptr = db.pointer;
    assert(typeof ptr === "number");
    const handle = ptr as DbPtr;
    try {
      db.exec("INSERT INTO t(id, v) VALUES (1, NULL)");
    } catch {
      // The throw is expected; the handle now carries the failing rc.
    }
    const classified = toSqliteError(SQLITE_CONSTRAINT, sqlite3, handle);
    assertInstanceOf(classified, SqliteConstraintError);
    assertEquals(classified.extendedCode, SQLITE_CONSTRAINT_NOTNULL);
    assert(classified.message.includes("t.v"));
  } finally {
    db.close();
  }
});
