import { assert, assertEquals, assertThrows } from "@std/assert";
import { openDatabase } from "../../src/database.ts";
import { SqliteMisuseError } from "../../src/errors.ts";
import { createTransactionFactory } from "../../src/transaction.ts";

const SQLITE_MISUSE = 21;

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-tx-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const count = (db: Awaited<ReturnType<typeof openDatabase>>): number => {
  const row = db.prepare<{ n: number }>("SELECT count(*) AS n FROM t").get();
  return row?.n ?? -1;
};

Deno.test("commit persists rows written inside the transaction", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/commit.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const tx = db.transaction();
    db.exec("INSERT INTO t(v) VALUES (1), (2)");
    tx.commit();
    assertEquals(count(db), 2);
  });
});

Deno.test("rollback discards rows written inside the transaction", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/rollback.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    db.exec("INSERT INTO t(v) VALUES (1)");
    const tx = db.transaction();
    db.exec("INSERT INTO t(v) VALUES (2), (3)");
    tx.rollback();
    assertEquals(count(db), 1);
  });
});

Deno.test("nested inner rollback discards inner work but outer commit keeps outer work", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/nested.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const outer = db.transaction();
    db.exec("INSERT INTO t(v) VALUES (1)");
    const inner = db.transaction();
    db.exec("INSERT INTO t(v) VALUES (2)");
    inner.rollback();
    db.exec("INSERT INTO t(v) VALUES (3)");
    outer.commit();
    assertEquals(db.prepare<{ v: number }>("SELECT v FROM t ORDER BY v").all(), [
      { v: 1 },
      { v: 3 },
    ]);
  });
});

Deno.test("a using transaction whose body throws auto-rolls-back with no partial commit", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/throw.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    assertThrows(() => {
      using _tx = db.transaction();
      db.exec("INSERT INTO t(v) VALUES (1)");
      throw new Error("body failed");
    }, Error);
    assertEquals(count(db), 0);
  });
});

Deno.test("a using transaction committed before scope exit persists its work", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/using-commit.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    {
      using tx = db.transaction();
      db.exec("INSERT INTO t(v) VALUES (7)");
      tx.commit();
    }
    assertEquals(count(db), 1);
  });
});

Deno.test("committing twice throws SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/double-commit.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const tx = db.transaction();
    tx.commit();
    assertThrows(() => tx.commit(), SqliteMisuseError);
  });
});

Deno.test("committing after a rollback throws SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/commit-after-rollback.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const tx = db.transaction();
    tx.rollback();
    assertThrows(() => tx.commit(), SqliteMisuseError);
  });
});

Deno.test("rolling back after dispose throws SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/rollback-after-dispose.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const tx = db.transaction();
    tx[Symbol.dispose]();
    assertThrows(() => tx.rollback(), SqliteMisuseError);
  });
});

Deno.test("a commit that throws on RELEASE does not latch the transaction finished", () => {
  const sql: string[] = [];
  let failRelease = true;
  const runSql = (s: string): void => {
    sql.push(s);
    if (failRelease && s.startsWith("RELEASE")) throw new Error("transient BUSY");
  };
  const tx = createTransactionFactory(runSql, SQLITE_MISUSE)();
  assertThrows(() => tx.commit(), Error, "transient BUSY");
  failRelease = false;
  tx[Symbol.dispose]();
  assert(sql.some((s) => s.startsWith("ROLLBACK TO sp_1")));
});

Deno.test("a failed commit can be retried after the transient cause clears", () => {
  let failRelease = true;
  const released: string[] = [];
  const runSql = (s: string): void => {
    if (s.startsWith("RELEASE")) {
      if (failRelease) throw new Error("transient BUSY");
      released.push(s);
    }
  };
  const tx = createTransactionFactory(runSql, SQLITE_MISUSE)();
  assertThrows(() => tx.commit(), Error, "transient BUSY");
  failRelease = false;
  tx.commit();
  assertThrows(() => tx.commit(), SqliteMisuseError);
  assertEquals(released, ["RELEASE sp_1"]);
});

Deno.test("three-level nesting commits the outer and middle while discarding the inner", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/three-level.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const outer = db.transaction();
    db.exec("INSERT INTO t(v) VALUES (1)");
    const middle = db.transaction();
    db.exec("INSERT INTO t(v) VALUES (2)");
    const inner = db.transaction();
    db.exec("INSERT INTO t(v) VALUES (3)");
    inner.rollback();
    middle.commit();
    outer.commit();
    assertEquals(db.prepare<{ v: number }>("SELECT v FROM t ORDER BY v").all(), [
      { v: 1 },
      { v: 2 },
    ]);
  });
});

Deno.test("two sequential top-level transactions both commit without a savepoint name collision", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/sequential.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const first = db.transaction();
    db.exec("INSERT INTO t(v) VALUES (1)");
    first.commit();
    const second = db.transaction();
    db.exec("INSERT INTO t(v) VALUES (2)");
    second.commit();
    assertEquals(count(db), 2);
  });
});

Deno.test("committing a transaction after the database is disposed throws a typed error", async () => {
  await withDir(async (dir) => {
    const db = await openDatabase(`${dir}/commit-after-db-dispose.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const tx = db.transaction();
    db[Symbol.dispose]();
    assertThrows(() => tx.commit(), SqliteMisuseError);
  });
});

Deno.test("disposing after an explicit commit is a no-op", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/dispose-after-commit.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const tx = db.transaction();
    db.exec("INSERT INTO t(v) VALUES (5)");
    tx.commit();
    tx[Symbol.dispose]();
    assertEquals(count(db), 1);
  });
});
