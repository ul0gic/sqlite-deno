import { dirname, resolve } from "@std/path";
import type { Sqlite3 } from "../glue.ts";
import type { CStrPtr, FilePtr, OutPtr } from "../wasm/ptr.ts";
import type { VfsMethods } from "./types.ts";
import type { OpenRegistry } from "./io.ts";
import { syncDir } from "./io.ts";
import type { ResultCodes } from "./errors.ts";
import { isNotFound } from "./errors.ts";
import { guardOpen, guardPath, isGranted } from "./guard.ts";

const SQLITE_SYNC_DIR = 1;

const isAbsent = (path: string): boolean => {
  try {
    Deno.statSync(path);
    return false;
  } catch (e) {
    if (isNotFound(e)) return true;
    throw e;
  }
};

const encoder = new TextEncoder();

export interface NamespaceDeps {
  readonly sqlite3: Sqlite3;
  readonly open: OpenRegistry;
  readonly rc: ResultCodes;
  readonly ioMethodsPtr: number;
  readonly setPMethods: (pFile: number, ptr: number) => void;
}

// `truncate` is never set: SQLite truncates via xTruncate, and a truncating open
// would discard a database SQLite expects to read back. CREATE+EXCLUSIVE → atomic O_EXCL.
const openOptions = (capi: Sqlite3["capi"], flags: number): Deno.OpenOptions => {
  const write = (flags & capi.SQLITE_OPEN_READWRITE) !== 0;
  const create = (flags & capi.SQLITE_OPEN_CREATE) !== 0;
  const exclusive = (flags & capi.SQLITE_OPEN_EXCLUSIVE) !== 0;
  return {
    read: true,
    write,
    ...(create && exclusive ? { createNew: true } : create ? { create: true } : {}),
  };
};

export const createVfsMethods = (deps: NamespaceDeps): VfsMethods => {
  const { sqlite3, open, rc, ioMethodsPtr, setPMethods } = deps;
  const { capi, wasm } = sqlite3;
  const asFile = (p: number): FilePtr => p as FilePtr;
  const asOut = (p: number): OutPtr => p as OutPtr;
  const asCStr = (p: number): CStrPtr => p as CStrPtr;
  const nameOf = (zName: number): string | null => (zName ? wasm.cstrToJs(asCStr(zName)) : null);

  return {
    xOpen: (
      _pVfs: number,
      zName: number,
      pFile: number,
      flags: number,
      pOutFlags: number,
    ): number => {
      try {
        const path = nameOf(zName);
        if (path === null) return rc.cantOpen;
        // Canonicalize-then-recheck before any open: Deno follows a symlink whose target
        // escapes the grant (SEC-001), so refuse before a create lands a file outside it.
        if (!isGranted(guardOpen(sqlite3, path, flags))) return rc.cantOpen;
        // os_unix.c sets UNIXFILE_DIRSYNC only when the open creates the dentry; pre-stat
        // under CREATE so the first xSync makes that dentry durable.
        const createsDentry = (flags & capi.SQLITE_OPEN_CREATE) !== 0 && isAbsent(path);
        const fd = Deno.openSync(path, openOptions(capi, flags));
        open.set(asFile(pFile), {
          fd,
          path,
          deleteOnClose: (flags & capi.SQLITE_OPEN_DELETEONCLOSE) !== 0,
          dirSyncPending: createsDentry,
          lockLevel: capi.SQLITE_LOCK_NONE,
        });
        setPMethods(pFile, ioMethodsPtr);
        if (pOutFlags) wasm.poke32(asOut(pOutFlags), flags);
        return rc.ok;
      } catch {
        return rc.cantOpen;
      }
    },
    xDelete: (_pVfs: number, zName: number, syncDirFlag: number): number => {
      try {
        const path = nameOf(zName);
        if (path === null) return rc.ok;
        // Canonicalize the parent before unlinking: a removeSync through an in-grant dir
        // symlink would land on an out-of-grant target (SEC-003); final component is lexical.
        if (!isGranted(guardPath(dirname(path), "write"))) return rc.ioErrDelete;
        try {
          Deno.removeSync(path);
        } catch (e) {
          if (isNotFound(e)) return rc.ok;
          throw e;
        }
        // fsync the parent after a commit-point unlink so the removed dentry is durable
        // (BUG-001 fix; DEC-008), matching os_unix.c.
        if ((syncDirFlag & SQLITE_SYNC_DIR) !== 0) syncDir(dirname(path));
        return rc.ok;
      } catch {
        return rc.ioErrDelete;
      }
    },
    xAccess: (_pVfs: number, zName: number, _flags: number, pResOut: number): number => {
      try {
        const path = nameOf(zName);
        let exists = false;
        // statSync follows the final symlink, so an in-grant symlink to an out-of-grant
        // file would leak its existence (SEC-003); canonicalize and report absent if escaped.
        if (path !== null && isGranted(guardPath(path, "read"))) {
          try {
            Deno.statSync(path);
            exists = true;
          } catch (e) {
            // Non-NotFound stat failures fail closed (IOERR_ACCESS), never false "absent":
            // a false absent on a hot -journal/-wal skips recovery on a torn db (DEC-006 §5).
            if (!isNotFound(e)) throw e;
          }
        }
        wasm.poke32(asOut(pResOut), exists ? 1 : 0);
        return rc.ok;
      } catch {
        return rc.ioErrAccess;
      }
    },
    xFullPathname: (_pVfs: number, zName: number, nOut: number, zOut: number): number => {
      try {
        const path = nameOf(zName);
        if (path === null) return rc.cantOpen;
        // `resolve` consults Deno.cwd() only on the relative branch (DBT-002, DEC-006 §6);
        // a runtime gating cwd behind --allow-read would CANTOPEN here only — do not assume free.
        const utf8 = encoder.encode(resolve(path));
        if (utf8.length + 1 > nOut) return rc.cantOpen;
        const heap = wasm.heap8u();
        heap.set(utf8, zOut);
        heap[zOut + utf8.length] = 0;
        return rc.ok;
      } catch {
        return rc.cantOpen;
      }
    },
  } satisfies VfsMethods;
};
