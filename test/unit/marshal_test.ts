import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { openDatabase } from "../../src/database.ts";
import { SqliteMisuseError, SqliteRangeError } from "../../src/errors.ts";

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-marshal-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

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

Deno.test("a fractional real value round-trips exactly by type", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/real.db`);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, r REAL)");
    const ins = db.prepare("INSERT INTO t(id, r) VALUES (?, ?)");
    ins.run(1, 0.1);
    ins.run(2, -2.5);
    ins.run(3, 1234.56789012345);
    const read = db.prepare<{ r: number }>("SELECT r FROM t WHERE id = ?");
    assertEquals(read.get(1)?.r, 0.1);
    assertEquals(read.get(2)?.r, -2.5);
    assertEquals(read.get(3)?.r, 1234.56789012345);
    assertEquals(typeof read.get(1)?.r, "number");
  });
});

Deno.test("an integer-valued number up to MAX_SAFE binds as an exact integer", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/intnum.db`);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    const ins = db.prepare("INSERT INTO t(id, v) VALUES (?, ?)");
    ins.run(1, 0);
    ins.run(2, -7);
    ins.run(3, Number.MAX_SAFE_INTEGER);
    const read = db.prepare<{ v: number | bigint }>("SELECT v FROM t WHERE id = ?");
    assertEquals(read.get(1)?.v, 0);
    assertEquals(read.get(2)?.v, -7);
    assertEquals(read.get(3)?.v, Number.MAX_SAFE_INTEGER);
  });
});

Deno.test("an integer-valued number above int64 range throws SqliteMisuseError (BUG-005)", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/bug005.db`);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    const ins = db.prepare("INSERT INTO t(id, v) VALUES (?, ?)");
    assertThrows(() => ins.run(1, 1e308), SqliteMisuseError);
    assertThrows(() => ins.run(2, 1e20), SqliteMisuseError);
    assertThrows(() => ins.run(3, 9.5e18), SqliteMisuseError);
    assertThrows(() => ins.run(4, Number.MAX_VALUE), SqliteMisuseError);
    assertThrows(() => ins.run(5, -1e308), SqliteMisuseError);
  });
});

Deno.test("an integer-valued number in int64 range round-trips and a non-integer real binds as float (BUG-005)", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/bug005-ok.db`);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v)");
    const ins = db.prepare("INSERT INTO t(id, v) VALUES (?, ?)");
    const read = db.prepare<{ v: number | bigint }>("SELECT v FROM t WHERE id = ?");
    ins.run(1, Number.MAX_SAFE_INTEGER);
    ins.run(2, 1.5e18);
    ins.run(3, 2.5);
    assertEquals(read.get(1)?.v, Number.MAX_SAFE_INTEGER);
    assertEquals(typeof read.get(1)?.v, "number");
    assertEquals(read.get(2)?.v, 1500000000000000000n);
    assertEquals(read.get(3)?.v, 2.5);
    assertEquals(typeof read.get(3)?.v, "number");
  });
});

Deno.test("positional ? binds by index and named-syntax placeholders bind positionally too", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/positional.db`);
    db.exec("CREATE TABLE t(a INTEGER, b INTEGER)");
    db.prepare("INSERT INTO t(a, b) VALUES (?, ?)").run(10, 20);
    db.prepare("INSERT INTO t(a, b) VALUES (:x, :y)").run(30, 40);
    assertEquals(db.prepare<{ a: number; b: number }>("SELECT a, b FROM t ORDER BY a").all(), [
      { a: 10, b: 20 },
      { a: 30, b: 40 },
    ]);
  });
});

Deno.test("binding more parameters than the statement declares throws SqliteRangeError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/too-many.db`);
    db.exec("CREATE TABLE t(a INTEGER)");
    const ins = db.prepare("INSERT INTO t(a) VALUES (?)");
    const err = assertThrows(() => ins.run(1, 2, 3), SqliteRangeError);
    assertEquals(err.code, 25);
  });
});

Deno.test("a ? left unbound by passing no parameters resolves to NULL", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/too-few.db`);
    db.exec("CREATE TABLE t(a INTEGER)");
    db.prepare("INSERT INTO t(a) VALUES (?)").run();
    assertEquals(db.prepare<{ a: number | null }>("SELECT a FROM t").get()?.a, null);
  });
});
