import { assert, assertEquals, assertInstanceOf, assertRejects, assertThrows } from "@std/assert";
import { openDatabase } from "../../src/database.ts";
import { SqliteError, SqliteMisuseError } from "../../src/errors.ts";

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-stmt-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const collect = async <Row>(stream: ReadableStream<Row>): Promise<Row[]> => {
  const out: Row[] = [];
  for await (const row of stream) out.push(row);
  return out;
};

Deno.test("stream yields the same rows as all for the same params", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/eq.db`);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)");
    db.exec("INSERT INTO t(id, n) VALUES (1, 10), (2, 20), (3, 30), (4, 40)");
    const q = db.prepare<{ id: number; n: number }>(
      "SELECT id, n FROM t WHERE n >= ? ORDER BY id",
    );
    assertEquals(await collect(q.stream(20)), q.all(20));
  });
});

Deno.test("stream widens an integer past 2^53 to an exact bigint", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/big.db`);
    db.exec("CREATE TABLE t(v INTEGER)");
    const big = 9007199254740993n;
    db.prepare("INSERT INTO t(v) VALUES (?), (?)").run(big, 5n);
    const rows = await collect(
      db.prepare<{ v: number | bigint }>("SELECT v FROM t ORDER BY v").stream(),
    );
    assertEquals(rows, [{ v: 5 }, { v: big }]);
    assertEquals(typeof rows[1]?.v, "bigint");
  });
});

Deno.test("an empty result set closes the stream with zero rows", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/empty.db`);
    db.exec("CREATE TABLE t(n INTEGER)");
    const rows = await collect(db.prepare<{ n: number }>("SELECT n FROM t").stream());
    assertEquals(rows, []);
  });
});

Deno.test("cancelling after one row resets the statement for immediate reuse", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/cancel.db`);
    db.exec("CREATE TABLE t(n INTEGER)");
    db.exec("INSERT INTO t(n) VALUES (1), (2), (3), (4), (5)");
    const q = db.prepare<{ n: number }>("SELECT n FROM t ORDER BY n");
    const reader = q.stream().getReader();
    const first = await reader.read();
    assertEquals(first, { done: false, value: { n: 1 } });
    await reader.cancel();
    assertEquals(q.all(), [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);
  });
});

Deno.test("a stream pulls one row per read rather than draining ahead", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/lazy.db`);
    db.exec("CREATE TABLE t(n INTEGER)");
    db.exec("INSERT INTO t(n) VALUES (1), (2), (3)");
    const reader = db.prepare<{ n: number }>("SELECT n FROM t ORDER BY n").stream()
      .getReader();
    assertEquals((await reader.read()).value, { n: 1 });
    assertEquals((await reader.read()).value, { n: 2 });
    assertEquals((await reader.read()).value, { n: 3 });
    assertEquals((await reader.read()).done, true);
    reader.releaseLock();
  });
});

Deno.test("a mid-scan engine error surfaces to the consumer and leaves the statement reusable", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/midscan.db`);
    const q = db.prepare<{ len: number }>(
      "WITH RECURSIVE g(s) AS (SELECT zeroblob(1000) UNION ALL " +
        "SELECT zeroblob(length(s) * 4) FROM g) SELECT length(s) AS len FROM g",
    );
    const reader = q.stream().getReader();
    assertEquals((await reader.read()).value, { len: 1000 });
    await assertRejects(async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    }, SqliteError);
    assertEquals(db.prepare<{ x: number }>("SELECT 1 AS x").get(), { x: 1 });
  });
});

Deno.test("streaming a finalized statement rejects the reader with SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/finalized.db`);
    db.exec("CREATE TABLE t(n INTEGER)");
    db.exec("INSERT INTO t(n) VALUES (1)");
    const q = db.prepare<{ n: number }>("SELECT n FROM t");
    q[Symbol.dispose]();
    const reader = q.stream().getReader();
    await assertRejects(() => reader.read(), SqliteMisuseError);
  });
});

Deno.test("a stream can be consumed through a TransformStream pipe", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/pipe.db`);
    db.exec("CREATE TABLE t(n INTEGER)");
    db.exec("INSERT INTO t(n) VALUES (1), (2), (3)");
    const doubled = new TransformStream<{ n: number }, number>({
      transform: (row, controller) => controller.enqueue(row.n * 2),
    });
    const piped = db.prepare<{ n: number }>("SELECT n FROM t ORDER BY n").stream()
      .pipeThrough(doubled);
    assertEquals(await collect(piped), [2, 4, 6]);
  });
});

Deno.test("a blob streams as a byte-identical copy out of wasm memory", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/blob.db`);
    db.exec("CREATE TABLE t(b BLOB)");
    const payload = new Uint8Array([0, 9, 200, 255]);
    db.prepare("INSERT INTO t(b) VALUES (?)").run(payload);
    const rows = await collect(db.prepare<{ b: Uint8Array }>("SELECT b FROM t").stream());
    assertInstanceOf(rows[0]?.b, Uint8Array);
    assertEquals(rows[0]?.b, payload);
  });
});

Deno.test("preparing empty, whitespace, or comment-only SQL throws SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/nostmt.db`);
    assertThrows(() => db.prepare(""), SqliteMisuseError);
    assertThrows(() => db.prepare("   "), SqliteMisuseError);
    assertThrows(() => db.prepare("-- only a comment"), SqliteMisuseError);
  });
});

Deno.test("a column named __proto__ round-trips its value on a null-prototype row", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/proto.db`);
    const row = db.prepare<Record<string, unknown>>(
      "SELECT 1 AS __proto__, 2 AS constructor, 3 AS normal",
    ).get();
    assert(row !== undefined);
    assertEquals(Object.getPrototypeOf(row), null);
    assertEquals(Object.getOwnPropertyDescriptor(row, "__proto__")?.value, 1);
    assertEquals(Object.getOwnPropertyDescriptor(row, "constructor")?.value, 2);
    assertEquals(Object.getOwnPropertyDescriptor(row, "normal")?.value, 3);
    assertEquals(Object.getOwnPropertyDescriptor({}, "polluted"), undefined);
  });
});

Deno.test("cancelling a stream after its statement is finalized is a no-op with no UB", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/cancel-finalized.db`);
    db.exec("CREATE TABLE t(n INTEGER)");
    db.exec("INSERT INTO t(n) VALUES (1), (2), (3)");
    const q = db.prepare<{ n: number }>("SELECT n FROM t ORDER BY n");
    const reader = q.stream().getReader();
    assertEquals((await reader.read()).value, { n: 1 });
    q[Symbol.dispose]();
    await reader.cancel();
    assertThrows(() => q.get(), SqliteMisuseError);
  });
});

Deno.test("cancelling a stale stream after another run took over leaves the live run intact", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/takeover.db`);
    db.exec("CREATE TABLE t(n INTEGER)");
    db.exec("INSERT INTO t(n) VALUES (1), (2), (3)");
    const q = db.prepare<{ n: number }>("SELECT n FROM t ORDER BY n");
    const stale = q.stream().getReader();
    assertEquals((await stale.read()).value, { n: 1 });
    assertEquals(q.all(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    await stale.cancel();
    assertEquals(q.get(), { n: 1 });
  });
});
