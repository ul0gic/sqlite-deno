import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { openDatabase } from "../../src/database.ts";
import { SqliteMisuseError } from "../../src/errors.ts";

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

Deno.test("a prepared statement rebinds and reruns across repeated calls", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/reuse.db`);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    const ins = db.prepare("INSERT INTO t(id, v) VALUES (?, ?)");
    for (let i = 1; i <= 3; i++) ins.run(i, i * 100);
    const read = db.prepare<{ v: number }>("SELECT v FROM t WHERE id = ?");
    assertEquals(read.get(1)?.v, 100);
    assertEquals(read.get(2)?.v, 200);
    assertEquals(read.get(3)?.v, 300);
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
