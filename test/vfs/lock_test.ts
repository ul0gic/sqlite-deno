import { assert, assertEquals } from "@std/assert";
import { loadSqlite3 } from "../../src/glue.ts";
import type { FilePtr } from "../../src/wasm/ptr.ts";
import { createLockMethods } from "../../src/vfs/lock.ts";
import type { OpenFile, OpenRegistry } from "../../src/vfs/io.ts";
import { resultCodes } from "../../src/vfs/errors.ts";
import { DENO_VFS_NAME, installDenoVfs } from "../../src/vfs/deno.ts";

type Sqlite3 = Awaited<ReturnType<typeof loadSqlite3>>;

const asFile = (p: number): FilePtr => p as FilePtr;

interface LockFixture {
  readonly sqlite3: Sqlite3;
  readonly lock: ReturnType<typeof createLockMethods>;
  readonly rc: ReturnType<typeof resultCodes>;
  readonly L: {
    readonly none: number;
    readonly shared: number;
    readonly reserved: number;
    readonly pending: number;
    readonly exclusive: number;
  };
  readonly register: (pFile: number, fd: Deno.FsFile) => void;
  readonly entry: (pFile: number) => OpenFile;
  readonly readResOut: (call: (pResOut: number) => number) => { rc: number; res: number };
  readonly dispose: () => void;
}

const makeFixture = async (): Promise<LockFixture> => {
  const sqlite3 = await loadSqlite3();
  const { capi, wasm } = sqlite3;
  const open: OpenRegistry = new Map();
  const rc = resultCodes(sqlite3);
  const lock = createLockMethods(sqlite3, open, rc);
  const handles: Deno.FsFile[] = [];
  return {
    sqlite3,
    lock,
    rc,
    L: {
      none: capi.SQLITE_LOCK_NONE,
      shared: capi.SQLITE_LOCK_SHARED,
      reserved: capi.SQLITE_LOCK_RESERVED,
      pending: capi.SQLITE_LOCK_PENDING,
      exclusive: capi.SQLITE_LOCK_EXCLUSIVE,
    },
    register: (pFile, fd) => {
      handles.push(fd);
      open.set(asFile(pFile), {
        fd,
        path: "",
        deleteOnClose: false,
        dirSyncPending: false,
        lockLevel: capi.SQLITE_LOCK_NONE,
      });
    },
    entry: (pFile) => {
      const f = open.get(asFile(pFile));
      if (!f) throw new Error("no entry");
      return f;
    },
    readResOut: (call) => {
      const stack = wasm.pstack.pointer;
      try {
        const p = wasm.pstack.alloc(4);
        const code = call(p);
        return { rc: code, res: Number(wasm.peek32(p)) };
      } finally {
        wasm.pstack.restore(stack);
      }
    },
    dispose: () => {
      for (const fd of handles) {
        try {
          fd.close();
        } catch { /* already closed by the test under exercise */ }
      }
    },
  };
};

const withDbFile = async (run: (path: string, fx: LockFixture) => void): Promise<void> => {
  const dir = Deno.makeTempDirSync({ prefix: "lock-" });
  const path = `${dir}/t.db`;
  const fx = await makeFixture();
  try {
    run(path, fx);
  } finally {
    fx.dispose();
    Deno.removeSync(dir, { recursive: true });
  }
};

Deno.test("xLock(SHARED) on a fresh file takes the exclusive flock and records SHARED", async () => {
  await withDbFile((path, fx) => {
    const fd = Deno.openSync(path, { create: true, read: true, write: true });
    fx.register(1, fd);
    assertEquals(fx.lock.xLock(1, fx.L.shared), fx.rc.ok);
    assertEquals(fx.entry(1).lockLevel, fx.L.shared);
  });
});

Deno.test("a second handle's xLock(SHARED) returns SQLITE_BUSY while the first holds the file", async () => {
  await withDbFile((path, fx) => {
    const a = Deno.openSync(path, { create: true, read: true, write: true });
    const b = Deno.openSync(path, { read: true, write: true });
    fx.register(1, a);
    fx.register(2, b);
    assertEquals(fx.lock.xLock(1, fx.L.shared), fx.rc.ok);
    assertEquals(fx.lock.xLock(2, fx.L.shared), fx.rc.busy);
    assertEquals(fx.entry(2).lockLevel, fx.L.none);
  });
});

Deno.test("escalating SHARED to RESERVED, PENDING, EXCLUSIVE is a pure state bump with no second flock", async () => {
  await withDbFile((path, fx) => {
    const fd = Deno.openSync(path, { create: true, read: true, write: true });
    fx.register(1, fd);
    assertEquals(fx.lock.xLock(1, fx.L.shared), fx.rc.ok);
    for (const level of [fx.L.reserved, fx.L.pending, fx.L.exclusive]) {
      assertEquals(fx.lock.xLock(1, level), fx.rc.ok);
      assertEquals(fx.entry(1).lockLevel, level);
    }
  });
});

Deno.test("re-requesting a level at or below the held level is a no-op OK", async () => {
  await withDbFile((path, fx) => {
    const fd = Deno.openSync(path, { create: true, read: true, write: true });
    fx.register(1, fd);
    assertEquals(fx.lock.xLock(1, fx.L.exclusive), fx.rc.ok);
    assertEquals(fx.lock.xLock(1, fx.L.shared), fx.rc.ok);
    assertEquals(fx.entry(1).lockLevel, fx.L.exclusive);
  });
});

Deno.test("xUnlock(SHARED) from EXCLUSIVE keeps the flock so a second handle still gets BUSY", async () => {
  await withDbFile((path, fx) => {
    const a = Deno.openSync(path, { create: true, read: true, write: true });
    const b = Deno.openSync(path, { read: true, write: true });
    fx.register(1, a);
    fx.register(2, b);
    fx.lock.xLock(1, fx.L.exclusive);
    assertEquals(fx.lock.xUnlock(1, fx.L.shared), fx.rc.ok);
    assertEquals(fx.entry(1).lockLevel, fx.L.shared);
    assertEquals(fx.lock.xLock(2, fx.L.shared), fx.rc.busy);
  });
});

Deno.test("xUnlock(NONE) releases the flock so a second handle then acquires SHARED", async () => {
  await withDbFile((path, fx) => {
    const a = Deno.openSync(path, { create: true, read: true, write: true });
    const b = Deno.openSync(path, { read: true, write: true });
    fx.register(1, a);
    fx.register(2, b);
    fx.lock.xLock(1, fx.L.exclusive);
    assertEquals(fx.lock.xLock(2, fx.L.shared), fx.rc.busy);
    assertEquals(fx.lock.xUnlock(1, fx.L.none), fx.rc.ok);
    assertEquals(fx.entry(1).lockLevel, fx.L.none);
    assertEquals(fx.lock.xLock(2, fx.L.shared), fx.rc.ok);
  });
});

Deno.test("a lock-unlock-relock cycle re-acquires the flock each time", async () => {
  await withDbFile((path, fx) => {
    const fd = Deno.openSync(path, { create: true, read: true, write: true });
    fx.register(1, fd);
    for (let i = 0; i < 3; i++) {
      assertEquals(fx.lock.xLock(1, fx.L.shared), fx.rc.ok);
      assertEquals(fx.lock.xUnlock(1, fx.L.none), fx.rc.ok);
      assertEquals(fx.entry(1).lockLevel, fx.L.none);
    }
  });
});

Deno.test("xUnlock(NONE) on an already-unlocked file is a no-op OK", async () => {
  await withDbFile((path, fx) => {
    const fd = Deno.openSync(path, { create: true, read: true, write: true });
    fx.register(1, fd);
    assertEquals(fx.lock.xUnlock(1, fx.L.none), fx.rc.ok);
    assertEquals(fx.entry(1).lockLevel, fx.L.none);
  });
});

Deno.test("xCheckReservedLock writes 0 and returns OK regardless of held level", async () => {
  await withDbFile((path, fx) => {
    const fd = Deno.openSync(path, { create: true, read: true, write: true });
    fx.register(1, fd);
    fx.lock.xLock(1, fx.L.exclusive);
    const { rc, res } = fx.readResOut((p) => fx.lock.xCheckReservedLock(1, p));
    assertEquals(rc, fx.rc.ok);
    assertEquals(res, 0);
  });
});

Deno.test("xLock on an unregistered file returns SQLITE_IOERR_LOCK rather than throwing", async () => {
  await withDbFile((_path, fx) => {
    assertEquals(fx.lock.xLock(999, fx.L.shared), fx.rc.ioErrLock);
    assertEquals(fx.lock.xUnlock(999, fx.L.none), fx.rc.ioErrUnlock);
    const { rc } = fx.readResOut((p) => fx.lock.xCheckReservedLock(999, p));
    assertEquals(rc, fx.rc.ioErrCheckReservedLock);
  });
});

Deno.test("two connections to one file serialize: the second's write fails BUSY under a zero busy_timeout", async () => {
  const sqlite3 = await loadSqlite3();
  installDenoVfs(sqlite3);
  const dir = Deno.makeTempDirSync({ prefix: "lock-oo1-" });
  const path = `${dir}/t.db`;
  const a = new sqlite3.oo1.DB(path, "c", DENO_VFS_NAME);
  const b = new sqlite3.oo1.DB(path, "w", DENO_VFS_NAME);
  try {
    a.exec("PRAGMA journal_mode=DELETE");
    a.exec("PRAGMA busy_timeout=0");
    b.exec("PRAGMA busy_timeout=0");
    a.exec("CREATE TABLE t(v INTEGER)");
    a.exec("BEGIN IMMEDIATE");
    a.exec("INSERT INTO t(v) VALUES (1)");
    let bBlocked = false;
    try {
      b.exec("INSERT INTO t(v) VALUES (2)");
    } catch {
      bBlocked = true;
    }
    assert(bBlocked, "the second connection should not write while the first holds the file");
    a.exec("COMMIT");
    const rows: number[] = [];
    a.exec({
      sql: "SELECT v FROM t",
      rowMode: "array",
      callback: (row) => void rows.push(Number(row[0])),
    });
    assertEquals(rows, [1]);
  } finally {
    a.close();
    b.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("after the first connection commits and yields the lock, the second commits cleanly", async () => {
  const sqlite3 = await loadSqlite3();
  installDenoVfs(sqlite3);
  const dir = Deno.makeTempDirSync({ prefix: "lock-oo1-" });
  const path = `${dir}/t.db`;
  const a = new sqlite3.oo1.DB(path, "c", DENO_VFS_NAME);
  const b = new sqlite3.oo1.DB(path, "w", DENO_VFS_NAME);
  try {
    a.exec("PRAGMA journal_mode=DELETE");
    a.exec("CREATE TABLE t(v INTEGER)");
    a.exec("INSERT INTO t(v) VALUES (1)");
    b.exec("INSERT INTO t(v) VALUES (2)");
    const rows: number[] = [];
    a.exec({
      sql: "SELECT v FROM t ORDER BY v",
      rowMode: "array",
      callback: (row) => void rows.push(Number(row[0])),
    });
    assertEquals(rows, [1, 2]);
  } finally {
    a.close();
    b.close();
    Deno.removeSync(dir, { recursive: true });
  }
});
