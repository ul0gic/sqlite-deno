import { assert, assertEquals, assertInstanceOf, assertRejects, assertThrows } from "@std/assert";
import { openDatabase } from "../src/database.ts";
import { SqliteCorruptError, SqliteMisuseError } from "../src/errors.ts";

const PAGE_SIZE = 4096;

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-untrusted-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const seedDb = async (path: string, rows: number): Promise<void> => {
  using db = await openDatabase(path);
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  const ins = db.prepare("INSERT INTO t(id, v) VALUES (?, ?)");
  for (let i = 1; i <= rows; i++) ins.run(i, "x".repeat(300));
};

Deno.test("opening a file of garbage bytes throws SqliteCorruptError, not a crash", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/garbage.db`;
    await Deno.writeFile(path, new TextEncoder().encode("definitely not a sqlite database file"));
    const err = await assertRejects(() => openDatabase(path), SqliteCorruptError);
    assertEquals(err.code, 26);
  });
});

Deno.test("opening a truncated SQLite-header file throws SqliteCorruptError", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/truncated.db`;
    const bytes = new Uint8Array(100);
    bytes.set(new TextEncoder().encode("SQLite format 3\0"), 0);
    await Deno.writeFile(path, bytes);
    await assertRejects(() => openDatabase(path), SqliteCorruptError);
  });
});

Deno.test("a header-page-only file with no payload throws SqliteCorruptError", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/header-only.db`;
    const bytes = new Uint8Array(512);
    bytes.set(new TextEncoder().encode("SQLite format 3\0"), 0);
    await Deno.writeFile(path, bytes);
    await assertRejects(() => openDatabase(path), SqliteCorruptError);
  });
});

Deno.test("a db that opens but is corrupt on a leaf page throws SqliteCorruptError on read and stays disposable", async () => {
  await withDir(async (dir) => {
    const seed = `${dir}/seed.db`;
    await seedDb(seed, 800);
    const bytes = await Deno.readFile(seed);
    const base = (10 - 1) * PAGE_SIZE;
    for (let i = 0; i < PAGE_SIZE; i++) bytes[base + i] = 0xff;
    const path = `${dir}/corrupt-leaf.db`;
    await Deno.writeFile(path, bytes);

    const db = await openDatabase(path);
    const stmt = db.prepare<{ id: number; v: string }>("SELECT id, v FROM t ORDER BY id");
    const err = assertThrows(() => stmt.all(), SqliteCorruptError);
    assertEquals(err.code, 11);
    stmt[Symbol.dispose]();
    db[Symbol.dispose]();
  });
});

Deno.test("undefined is rejected as a misuse, never silently bound as NULL", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/undef.db`);
    db.exec("CREATE TABLE t(v)");
    const ins = db.prepare("INSERT INTO t(v) VALUES (?)") as unknown as {
      run: (p: unknown) => unknown;
    };
    assertThrows(() => ins.run(undefined), SqliteMisuseError);
    const n = db.prepare<{ n: number }>("SELECT count(*) AS n FROM t").get()?.n;
    assertEquals(n, 0);
  });
});

Deno.test("every unsupported bind type is rejected with SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/badtypes.db`);
    db.exec("CREATE TABLE t(v)");
    const ins = db.prepare("INSERT INTO t(v) VALUES (?)") as unknown as {
      run: (p: unknown) => unknown;
    };
    assertThrows(() => ins.run(true), SqliteMisuseError);
    assertThrows(() => ins.run(false), SqliteMisuseError);
    assertThrows(() => ins.run({}), SqliteMisuseError);
    assertThrows(() => ins.run(Symbol("s")), SqliteMisuseError);
    assertThrows(() => ins.run(() => {}), SqliteMisuseError);
    assertThrows(() => ins.run(new Date()), SqliteMisuseError);
  });
});

Deno.test("malformed UTF-8 in a TEXT value reads back as replacement chars without throwing", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/utf.db`);
    const lone = db.prepare<{ s: string }>("SELECT CAST(x'fffe' AS TEXT) AS s").get();
    assertEquals(lone?.s, "��");
    const truncated = db.prepare<{ s: string }>("SELECT CAST(x'e282' AS TEXT) AS s").get();
    assertEquals(truncated?.s, "�");
    const ok = db.prepare<{ s: string }>("SELECT 'plain' AS s").get();
    assertEquals(ok?.s, "plain");
  });
});

Deno.test("a multi-megabyte blob round-trips byte-identical through heap-grow", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/bigblob.db`);
    db.exec("CREATE TABLE t(b BLOB)");
    const payload = new Uint8Array(4 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) & 0xff;
    db.prepare("INSERT INTO t(b) VALUES (?)").run(payload);
    const got = db.prepare<{ b: Uint8Array }>("SELECT b FROM t").get()?.b;
    assertInstanceOf(got, Uint8Array);
    assertEquals(got.length, payload.length);
    assert(got.every((byte, i) => byte === payload[i]));
  });
});
