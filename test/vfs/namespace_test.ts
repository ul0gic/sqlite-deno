import { assert, assertEquals } from "@std/assert";
import { isAbsolute, resolve } from "@std/path";
import { loadSqlite3 } from "../../src/glue.ts";
import { resultCodes } from "../../src/vfs/errors.ts";
import { createVfsMethods } from "../../src/vfs/namespace.ts";
import type { OpenRegistry } from "../../src/vfs/io.ts";

type Sqlite3 = Awaited<ReturnType<typeof loadSqlite3>>;

const buildVfs = (sqlite3: Sqlite3) => {
  const open: OpenRegistry = new Map();
  return createVfsMethods({
    sqlite3,
    open,
    rc: resultCodes(sqlite3),
    ioMethodsPtr: 0,
    setPMethods: () => {},
  });
};

const callAccess = (sqlite3: Sqlite3, vfs: ReturnType<typeof buildVfs>, path: string) => {
  const { wasm } = sqlite3;
  const zName = wasm.allocCString(path, false);
  const pResOut = wasm.alloc(4);
  try {
    wasm.poke32(pResOut, 0x7f);
    const code = vfs.xAccess(0, zName, sqlite3.capi.SQLITE_ACCESS_EXISTS, pResOut);
    return { code, resOut: wasm.peek32(pResOut) };
  } finally {
    wasm.dealloc(zName);
    wasm.dealloc(pResOut);
  }
};

const callFullPathname = (sqlite3: Sqlite3, vfs: ReturnType<typeof buildVfs>, path: string) => {
  const { wasm } = sqlite3;
  const nOut = 1024;
  const zName = wasm.allocCString(path, false);
  const zOut = wasm.alloc(nOut);
  try {
    const code = vfs.xFullPathname(0, zName, nOut, zOut);
    return { code, out: wasm.cstrToJs(zOut) };
  } finally {
    wasm.dealloc(zName);
    wasm.dealloc(zOut);
  }
};

const realStatSync = Deno.statSync.bind(Deno);

const withStatThrowing = (target: string, err: Error, run: () => void): void => {
  Object.defineProperty(Deno, "statSync", {
    configurable: true,
    writable: true,
    value: (path: string | URL): Deno.FileInfo => {
      if (typeof path === "string" && path === target) throw err;
      return realStatSync(path);
    },
  });
  try {
    run();
  } finally {
    Object.defineProperty(Deno, "statSync", {
      configurable: true,
      writable: true,
      value: realStatSync,
    });
  }
};

Deno.test("xAccess reports an in-grant existing file as accessible (pResOut=1, SQLITE_OK)", async () => {
  const sqlite3 = await loadSqlite3();
  const vfs = buildVfs(sqlite3);
  const dir = await Deno.makeTempDir({ prefix: "namespace-access-" });
  try {
    const path = `${dir}/present.db`;
    Deno.writeTextFileSync(path, "");
    const { code, resOut } = callAccess(sqlite3, vfs, path);
    assertEquals(code, sqlite3.capi.SQLITE_OK);
    assertEquals(resOut, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("xAccess reports a NotFound path as not-existing (pResOut=0, SQLITE_OK)", async () => {
  const sqlite3 = await loadSqlite3();
  const vfs = buildVfs(sqlite3);
  const dir = await Deno.makeTempDir({ prefix: "namespace-access-" });
  try {
    const { code, resOut } = callAccess(sqlite3, vfs, `${dir}/absent.db`);
    assertEquals(code, sqlite3.capi.SQLITE_OK);
    assertEquals(resOut, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("xAccess fails closed with SQLITE_IOERR_ACCESS when an in-grant stat is denied (DEC-006 §5)", async () => {
  const sqlite3 = await loadSqlite3();
  const vfs = buildVfs(sqlite3);
  const dir = await Deno.makeTempDir({ prefix: "namespace-access-" });
  try {
    const path = `${dir}/denied.db`;
    Deno.writeTextFileSync(path, "");
    let result: { code: number; resOut: number } | undefined;
    withStatThrowing(path, new Deno.errors.PermissionDenied("denied"), () => {
      result = callAccess(sqlite3, vfs, path);
    });
    assert(result !== undefined);
    assertEquals(result.code, sqlite3.capi.SQLITE_IOERR_ACCESS);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("xAccess maps a transient in-grant stat I/O failure to SQLITE_IOERR_ACCESS, never a false absent", async () => {
  const sqlite3 = await loadSqlite3();
  const vfs = buildVfs(sqlite3);
  const dir = await Deno.makeTempDir({ prefix: "namespace-access-" });
  try {
    const path = `${dir}/io.db`;
    Deno.writeTextFileSync(path, "");
    let result: { code: number; resOut: number } | undefined;
    withStatThrowing(path, new Error("EIO"), () => {
      result = callAccess(sqlite3, vfs, path);
    });
    assert(result !== undefined);
    assertEquals(result.code, sqlite3.capi.SQLITE_IOERR_ACCESS);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("xFullPathname returns an absolute path unchanged (DBT-002 documented anchor)", async () => {
  const sqlite3 = await loadSqlite3();
  const vfs = buildVfs(sqlite3);
  const dir = await Deno.makeTempDir({ prefix: "namespace-fullpath-" });
  try {
    const path = resolve(dir, "abs.db");
    assert(isAbsolute(path));
    const { code, out } = callFullPathname(sqlite3, vfs, path);
    assertEquals(code, sqlite3.capi.SQLITE_OK);
    assert(out !== null);
    assert(isAbsolute(out), `expected an absolute path, got ${out}`);
    assertEquals(out, path);
    assertEquals(out, resolve(path));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("xFullPathname anchors a relative path to the process cwd (DBT-002)", async () => {
  const sqlite3 = await loadSqlite3();
  const vfs = buildVfs(sqlite3);
  const { code, out } = callFullPathname(sqlite3, vfs, "rel.db");
  assertEquals(code, sqlite3.capi.SQLITE_OK);
  assert(out !== null);
  assert(isAbsolute(out), `expected an absolute path, got ${out}`);
  assertEquals(out, resolve(Deno.cwd(), "rel.db"));
});
