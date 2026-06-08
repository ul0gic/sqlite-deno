import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { openDatabase } from "../../src/database.ts";
import { SqliteMisuseError } from "../../src/errors.ts";

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-open-opts-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

Deno.test("busyTimeout defaults to 0 (immediate BUSY, backward-compatible)", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/bt-default.db`);
    assertEquals(
      db.prepare<{ timeout: number }>("PRAGMA busy_timeout").get()?.timeout,
      0,
    );
  });
});

Deno.test("busyTimeout applies the configured millisecond value", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/bt-set.db`, { busyTimeout: 2500 });
    assertEquals(
      db.prepare<{ timeout: number }>("PRAGMA busy_timeout").get()?.timeout,
      2500,
    );
  });
});

Deno.test("busyTimeout of 0 is explicit and equals the default", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/bt-zero.db`, { busyTimeout: 0 });
    assertEquals(
      db.prepare<{ timeout: number }>("PRAGMA busy_timeout").get()?.timeout,
      0,
    );
  });
});

Deno.test("busyTimeout composes with wal mode", async () => {
  await withDir(async (dir) => {
    using db = await openDatabase(`${dir}/bt-wal.db`, { mode: "wal", busyTimeout: 750 });
    assertEquals(
      db.prepare<{ timeout: number }>("PRAGMA busy_timeout").get()?.timeout,
      750,
    );
  });
});

Deno.test("a negative busyTimeout rejects with SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    await assertRejects(
      () => openDatabase(`${dir}/bt-negative.db`, { busyTimeout: -1 }),
      SqliteMisuseError,
    );
  });
});

Deno.test("a fractional busyTimeout rejects with SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    await assertRejects(
      () => openDatabase(`${dir}/bt-fraction.db`, { busyTimeout: 12.5 }),
      SqliteMisuseError,
    );
  });
});

Deno.test("a NaN busyTimeout rejects with SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    await assertRejects(
      () => openDatabase(`${dir}/bt-nan.db`, { busyTimeout: Number.NaN }),
      SqliteMisuseError,
    );
  });
});

Deno.test("an Infinity busyTimeout rejects with SqliteMisuseError", async () => {
  await withDir(async (dir) => {
    await assertRejects(
      () => openDatabase(`${dir}/bt-inf.db`, { busyTimeout: Number.POSITIVE_INFINITY }),
      SqliteMisuseError,
    );
  });
});

Deno.test("an invalid busyTimeout rejects before touching the filesystem", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/bt-no-file.db`;
    await assertRejects(() => openDatabase(path, { busyTimeout: -5 }), SqliteMisuseError);
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  });
});

Deno.test("an already-aborted signal rejects the open with the default reason", async () => {
  await withDir(async (dir) => {
    const controller = new AbortController();
    controller.abort();
    const err = await assertRejects(() =>
      openDatabase(`${dir}/sig-aborted.db`, { signal: controller.signal })
    );
    assertInstanceOf(err, DOMException);
    assertEquals(err.name, "AbortError");
  });
});

Deno.test("an already-aborted signal propagates a custom reason", async () => {
  await withDir(async (dir) => {
    const reason = new Error("caller cancelled");
    const controller = new AbortController();
    controller.abort(reason);
    const err = await assertRejects(() =>
      openDatabase(`${dir}/sig-custom.db`, { signal: controller.signal })
    );
    assertEquals(err, reason);
  });
});

Deno.test("an aborted signal opens no file", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/sig-no-file.db`;
    const controller = new AbortController();
    controller.abort();
    await assertRejects(() => openDatabase(path, { signal: controller.signal }));
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  });
});

Deno.test("a live signal opens normally and the database is usable", async () => {
  await withDir(async (dir) => {
    const controller = new AbortController();
    using db = await openDatabase(`${dir}/sig-live.db`, { signal: controller.signal });
    db.exec("CREATE TABLE t(n INTEGER)");
    db.exec("INSERT INTO t(n) VALUES (42)");
    assertEquals(db.prepare<{ n: number }>("SELECT n FROM t").get()?.n, 42);
  });
});

Deno.test("busyTimeout and signal compose on one open", async () => {
  await withDir(async (dir) => {
    const controller = new AbortController();
    using db = await openDatabase(`${dir}/combined.db`, {
      busyTimeout: 1000,
      signal: controller.signal,
    });
    assertEquals(
      db.prepare<{ timeout: number }>("PRAGMA busy_timeout").get()?.timeout,
      1000,
    );
  });
});
