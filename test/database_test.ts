import { assert, assertEquals, assertInstanceOf, assertRejects, assertThrows } from "@std/assert";
import { openDatabase } from "../src/database.ts";
import {
  SqliteBusyError,
  SqliteCantOpenError,
  SqliteConstraintError,
  SqliteMisuseError,
  SqliteReadonlyError,
} from "../src/errors.ts";

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-db-" });
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

Deno.test("exec then prepare round-trips rows in default rollback mode", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/round.db`);
    db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO users(id, name) VALUES (1, 'alice'), (2, 'bob')");
    const find = db.prepare<{ id: number; name: string }>(
      "SELECT id, name FROM users WHERE id = ?",
    );
    const row = find.get(1);
    assertEquals(row, { id: 1, name: "alice" });
    assertEquals(find.get(2), { id: 2, name: "bob" });
    assertEquals(find.get(99), undefined);
  });
});

Deno.test("all collects every row and respects bound parameters", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/all.db`);
    db.exec("CREATE TABLE t(n INTEGER)");
    db.exec("INSERT INTO t(n) VALUES (1), (2), (3), (4)");
    const evens = db.prepare<{ n: number }>("SELECT n FROM t WHERE n % 2 = ? ORDER BY n");
    assertEquals(evens.all(0), [{ n: 2 }, { n: 4 }]);
    assertEquals(evens.all(1), [{ n: 1 }, { n: 3 }]);
  });
});

Deno.test("integer below 2^53 reads back as a number", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/small-int.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    db.prepare("INSERT INTO t(v) VALUES (?)").run(5);
    const v = db.prepare<{ v: number | bigint }>("SELECT v FROM t").get()?.v;
    assertEquals(v, 5);
    assertEquals(typeof v, "number");
  });
});

Deno.test("integer past 2^53 reads back as an exact bigint", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/big-int.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const big = 9007199254740993n;
    db.prepare("INSERT INTO t(v) VALUES (?)").run(big);
    const v = db.prepare<{ v: number | bigint }>("SELECT v FROM t").get()?.v;
    assertEquals(v, big);
    assertEquals(typeof v, "bigint");
  });
});

Deno.test("MAX_SAFE_INTEGER stays a number and one past it becomes a bigint", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/boundary.db`);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    const ins = db.prepare("INSERT INTO t(id, v) VALUES (?, ?)");
    ins.run(1, BigInt(Number.MAX_SAFE_INTEGER));
    ins.run(2, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    const read = db.prepare<{ v: number | bigint }>("SELECT v FROM t WHERE id = ?");
    assertEquals(read.get(1)?.v, Number.MAX_SAFE_INTEGER);
    assertEquals(typeof read.get(1)?.v, "number");
    assertEquals(read.get(2)?.v, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    assertEquals(typeof read.get(2)?.v, "bigint");
  });
});

Deno.test("float, text, and null values round-trip by type", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/types.db`);
    db.exec("CREATE TABLE t(f REAL, s TEXT, n INTEGER)");
    db.prepare("INSERT INTO t(f, s, n) VALUES (?, ?, ?)").run(3.5, "héllo", null);
    const row = db.prepare<{ f: number; s: string; n: number | bigint | null }>(
      "SELECT f, s, n FROM t",
    ).get();
    assertEquals(row, { f: 3.5, s: "héllo", n: null });
  });
});

Deno.test("a blob round-trips as a byte-identical copy out of wasm memory", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/blob.db`);
    db.exec("CREATE TABLE t(b BLOB)");
    const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
    db.prepare("INSERT INTO t(b) VALUES (?)").run(payload);
    const got = db.prepare<{ b: Uint8Array }>("SELECT b FROM t").get()?.b;
    assertInstanceOf(got, Uint8Array);
    assertEquals(got, payload);
  });
});

Deno.test("an empty blob round-trips as a zero-length Uint8Array", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/empty-blob.db`);
    db.exec("CREATE TABLE t(b BLOB)");
    db.prepare("INSERT INTO t(b) VALUES (?)").run(new Uint8Array(0));
    const got = db.prepare<{ b: Uint8Array }>("SELECT b FROM t").get()?.b;
    assertInstanceOf(got, Uint8Array);
    assertEquals(got.length, 0);
  });
});

Deno.test("run reports changes and last insert rowid", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/run.db`);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const ins = db.prepare("INSERT INTO t(v) VALUES (?)");
    const first = ins.run("a");
    assertEquals(first.changes, 1);
    assertEquals(first.lastInsertRowid, 1);
    ins.run("b");
    const del = db.prepare("DELETE FROM t").run();
    assertEquals(del.changes, 2);
  });
});

Deno.test("a rowid past 2^53 surfaces as a bigint", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/big-rowid.db`);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const big = 9007199254740993n;
    db.prepare("INSERT INTO t(id, v) VALUES (?, ?)").run(big, "x");
    const { lastInsertRowid } = db.prepare("INSERT INTO t(v) VALUES (?)").run("y");
    assertEquals(typeof lastInsertRowid, "bigint");
    assertEquals(lastInsertRowid, big + 1n);
  });
});

Deno.test("iter yields rows lazily and resets after an early break", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/iter.db`);
    db.exec("CREATE TABLE t(n INTEGER)");
    db.exec("INSERT INTO t(n) VALUES (1), (2), (3), (4), (5)");
    const q = db.prepare<{ n: number }>("SELECT n FROM t ORDER BY n");
    const seen: number[] = [];
    for (const row of q.iter()) {
      seen.push(row.n);
      if (row.n === 2) break;
    }
    assertEquals(seen, [1, 2]);
    assertEquals(q.all(), [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);
  });
});

Deno.test("using a finalized statement throws SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/finalized.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const stmt = db.prepare<{ v: number }>("SELECT v FROM t");
    stmt[Symbol.dispose]();
    assertThrows(() => stmt.get(), SqliteMisuseError);
  });
});

Deno.test("disposing the database finalizes still-open statements", async () => {
  await withDir(async (dir) => {
    const db = await openDatabase(`${dir}/dispose.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const stmt = db.prepare<{ v: number }>("SELECT v FROM t");
    db[Symbol.dispose]();
    assertThrows(() => stmt.get(), SqliteMisuseError);
  });
});

Deno.test("disposing the database twice is a no-op", async () => {
  await withDir(async (dir) => {
    const db = await openDatabase(`${dir}/double-dispose.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    db[Symbol.dispose]();
    db[Symbol.dispose]();
  });
});

Deno.test("rollback mode creates no -wal and leaves a -journal artifact", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/rollback.db`;
    using db = await openDatabase(path);
    db.exec("CREATE TABLE t(v INTEGER)");
    db.exec("INSERT INTO t(v) VALUES (1)");
    assertEquals(existsSync(`${path}-wal`), false);
    assertEquals(existsSync(`${path}-shm`), false);
  });
});

Deno.test("WAL mode engages and creates a -wal but never a -shm", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/wal.db`;
    using db = await openDatabase(path, { mode: "wal", durability: "full" });
    db.exec("CREATE TABLE t(v INTEGER)");
    db.exec("INSERT INTO t(v) VALUES (1), (2), (3)");
    const journal = db.prepare<{ journal_mode: string }>("PRAGMA journal_mode").get()
      ?.journal_mode;
    assertEquals(journal, "wal");
    assert(existsSync(`${path}-wal`), "WAL mode must create a -wal");
    assertEquals(existsSync(`${path}-shm`), false);
  });
});

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

Deno.test("data persists across a close and reopen in rollback mode", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/persist.db`;
    {
      using db = await openDatabase(path);
      db.exec("CREATE TABLE t(v TEXT)");
      db.prepare("INSERT INTO t(v) VALUES (?)").run("durable");
    }
    using db = await openDatabase(path);
    assertEquals(db.prepare<{ v: string }>("SELECT v FROM t").get()?.v, "durable");
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

Deno.test("binding a bigint above the int64 range throws SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/over-i64.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const ins = db.prepare("INSERT INTO t(v) VALUES (?)");
    assertThrows(() => ins.run(2n ** 63n), SqliteMisuseError);
  });
});

Deno.test("binding a bigint below the int64 range throws SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/under-i64.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const ins = db.prepare("INSERT INTO t(v) VALUES (?)");
    assertThrows(() => ins.run(-(2n ** 63n) - 1n), SqliteMisuseError);
  });
});

Deno.test("a large in-range bigint binds and round-trips exactly", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/big-in-range.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    db.prepare("INSERT INTO t(v) VALUES (?)").run(2n ** 62n);
    assertEquals(db.prepare<{ v: bigint }>("SELECT v FROM t").get()?.v, 2n ** 62n);
  });
});

Deno.test("the inclusive int64 bind boundaries round-trip but one past either end throws", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/i64-edge.db`);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    const ins = db.prepare("INSERT INTO t(id, v) VALUES (?, ?)");
    const read = db.prepare<{ v: bigint }>("SELECT v FROM t WHERE id = ?");
    ins.run(1, 2n ** 63n - 1n);
    ins.run(2, -(2n ** 63n));
    assertEquals(read.get(1)?.v, 2n ** 63n - 1n);
    assertEquals(read.get(2)?.v, -(2n ** 63n));
    assertThrows(() => ins.run(3, 2n ** 63n), SqliteMisuseError);
    assertThrows(() => ins.run(4, -(2n ** 63n) - 1n), SqliteMisuseError);
  });
});

Deno.test("the negative i64 column boundary narrows at MIN_SAFE and widens past it", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/neg-read.db`);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    const ins = db.prepare("INSERT INTO t(id, v) VALUES (?, ?)");
    ins.run(1, -(2n ** 53n - 1n));
    ins.run(2, -(2n ** 53n));
    const read = db.prepare<{ v: number | bigint }>("SELECT v FROM t WHERE id = ?");
    assertEquals(read.get(1)?.v, -9007199254740991);
    assertEquals(typeof read.get(1)?.v, "number");
    assertEquals(read.get(2)?.v, -9007199254740992n);
    assertEquals(typeof read.get(2)?.v, "bigint");
  });
});

Deno.test("NULL, empty string, and empty blob are three distinguishable round-trips", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/distinct.db`);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, txt TEXT, blb BLOB)");
    const ins = db.prepare("INSERT INTO t(id, txt, blb) VALUES (?, ?, ?)");
    ins.run(1, null, null);
    ins.run(2, "", new Uint8Array(0));
    const read = db.prepare<{ txt: string | null; blb: Uint8Array | null }>(
      "SELECT txt, blb FROM t WHERE id = ?",
    );
    const a = read.get(1);
    assertEquals(a?.txt, null);
    assertEquals(a?.blb, null);
    const b = read.get(2);
    assertEquals(b?.txt, "");
    assertInstanceOf(b?.blb, Uint8Array);
    assertEquals(b.blb.length, 0);
  });
});

Deno.test("a duplicate output column name resolves last-wins on the null-prototype row", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/dup-col.db`);
    const row = db.prepare<{ id: number }>("SELECT 1 AS id, 2 AS id").get();
    assertEquals(row, { id: 2 });
    assertEquals(row && Object.keys(row), ["id"]);
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
    await assertRejects(
      () => openDatabase(path, { mode: "wal", durability: "full" }),
      SqliteBusyError,
    );
  });
});

Deno.test("durability normal and full set synchronous to 1 and 2 respectively", async () => {
  await withDir(async (dir) => {
    {
      using normal = await openDatabase(`${dir}/sync-normal.db`, {
        mode: "wal",
        durability: "normal",
      });
      assertEquals(
        normal.prepare<{ synchronous: number }>("PRAGMA synchronous").get()?.synchronous,
        1,
      );
    }
    using full = await openDatabase(`${dir}/sync-full.db`, { mode: "wal", durability: "full" });
    assertEquals(
      full.prepare<{ synchronous: number }>("PRAGMA synchronous").get()?.synchronous,
      2,
    );
  });
});

Deno.test("the default rollback mode sets journal_mode persist and synchronous FULL (durable-by-default, BUG-004)", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/rollback-env.db`);
    assertEquals(
      db.prepare<{ journal_mode: string }>("PRAGMA journal_mode").get()?.journal_mode,
      "persist",
    );
    assertEquals(
      db.prepare<{ synchronous: number }>("PRAGMA synchronous").get()?.synchronous,
      2,
    );
  });
});

Deno.test("rollback mode with durability normal sets synchronous NORMAL (the explicit weaker opt-in)", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/rollback-normal.db`, { durability: "normal" });
    assertEquals(
      db.prepare<{ journal_mode: string }>("PRAGMA journal_mode").get()?.journal_mode,
      "persist",
    );
    assertEquals(
      db.prepare<{ synchronous: number }>("PRAGMA synchronous").get()?.synchronous,
      1,
    );
  });
});

Deno.test("every statement method throws SqliteMisuseError after the database is disposed", async () => {
  await withDir(async (dir) => {
    const db = await openDatabase(`${dir}/post-dispose.db`);
    db.exec("CREATE TABLE t(n INTEGER)");
    db.exec("INSERT INTO t(n) VALUES (1)");
    const stmt = db.prepare<{ n: number }>("SELECT n FROM t");
    db[Symbol.dispose]();
    assertThrows(() => stmt.get(), SqliteMisuseError);
    assertThrows(() => stmt.all(), SqliteMisuseError);
    assertThrows(() => stmt.run(), SqliteMisuseError);
    assertThrows(() => {
      for (const _ of stmt.iter()) break;
    }, SqliteMisuseError);
  });
});

Deno.test("streaming a statement after the database is disposed rejects the reader", async () => {
  await withDir(async (dir) => {
    const db = await openDatabase(`${dir}/post-dispose-stream.db`);
    db.exec("CREATE TABLE t(n INTEGER)");
    db.exec("INSERT INTO t(n) VALUES (1)");
    const stmt = db.prepare<{ n: number }>("SELECT n FROM t");
    const stream = stmt.stream();
    db[Symbol.dispose]();
    await assertRejects(() => stream.getReader().read(), SqliteMisuseError);
  });
});
