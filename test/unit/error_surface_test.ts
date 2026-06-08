import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { openDatabase } from "../../src/database.ts";
import {
  SqliteBusyError,
  SqliteCantOpenError,
  SqliteConstraintError,
  SqliteError,
  SqliteMisuseError,
  SqliteReadonlyError,
} from "../../src/errors.ts";

const SQLITE_ERROR = 1;

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-errsurface-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const existsSync = (path: string): boolean => {
  try {
    Deno.statSync(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
};

Deno.test("a unique-constraint violation surfaces SqliteConstraintError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/constraint.db`);
    db.exec("CREATE TABLE t(email TEXT UNIQUE)");
    const ins = db.prepare("INSERT INTO t(email) VALUES (?)");
    ins.run("a@b.c");
    const err = assertThrows(() => ins.run("a@b.c"), SqliteConstraintError);
    assertEquals(err.code, 19);
  });
});

Deno.test("a NOT NULL violation surfaces SqliteConstraintError with the NOTNULL extended code", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/notnull.db`);
    db.exec("CREATE TABLE t(v INTEGER NOT NULL)");
    const ins = db.prepare("INSERT INTO t(v) VALUES (?)");
    const err = assertThrows(() => ins.run(null), SqliteConstraintError);
    assertEquals(err.code, 19);
    assertEquals(err.extendedCode, 1299);
  });
});

Deno.test("a syntax error surfaces the base SqliteError, not a crash", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/syntax.db`);
    const execErr = assertThrows(() => db.exec("SELEKT 1"), SqliteError);
    assertEquals(execErr.code, SQLITE_ERROR);
    assertEquals(execErr.constructor, SqliteError);
    assert(execErr.message.length > 0);
    const prepErr = assertThrows(() => db.prepare("INSERT INTO"), SqliteError);
    assertEquals(prepErr.code, SQLITE_ERROR);
  });
});

Deno.test("referencing a missing table surfaces the base SqliteError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/no-table.db`);
    const err = assertThrows(() => db.prepare("SELECT * FROM nonexistent"), SqliteError);
    assertEquals(err.code, SQLITE_ERROR);
  });
});

Deno.test("binding a value of an unsupported type throws SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/bad-bind.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const ins = db.prepare("INSERT INTO t(v) VALUES (?)");
    const bound = ins as unknown as { run: (p: unknown) => unknown };
    assertThrows(() => bound.run(true), SqliteMisuseError);
  });
});

Deno.test("opening readonly together with mode wal throws SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    await assertRejects(
      () => openDatabase(`${dir}/ro-wal.db`, { mode: "wal", readonly: true }),
      SqliteMisuseError,
    );
  });
});

Deno.test("a readonly connection serves reads but rejects writes with SqliteReadonlyError", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/ro.db`;
    {
      using seed = await openDatabase(path);
      seed.exec("CREATE TABLE t(v INTEGER)");
      seed.exec("INSERT INTO t(v) VALUES (1)");
    }
    using db = await openDatabase(path, { readonly: true });
    assertEquals(db.prepare<{ v: number }>("SELECT v FROM t").get()?.v, 1);
    assertThrows(() => db.exec("INSERT INTO t(v) VALUES (2)"), SqliteReadonlyError);
  });
});

Deno.test("a readonly open of a missing path throws SqliteCantOpenError and creates no file", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/missing-ro.db`;
    await assertRejects(() => openDatabase(path, { readonly: true }), SqliteCantOpenError);
    assertEquals(existsSync(path), false);
  });
});

Deno.test("a second WAL connection to the same file is refused by the exclusive lock", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/wal-excl.db`;
    using db1 = await openDatabase(path, { mode: "wal", durability: "full" });
    db1.exec("CREATE TABLE t(v INTEGER)");
    db1.exec("INSERT INTO t(v) VALUES (1)");
    const err = await assertRejects(
      () => openDatabase(path, { mode: "wal", durability: "full" }),
      SqliteBusyError,
    );
    assertEquals(err.code, 5);
  });
});
