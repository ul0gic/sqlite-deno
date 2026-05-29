import { resolve } from "@std/path";
import type { Sqlite3 } from "../glue.ts";
import type { CStrPtr, FilePtr, OutPtr } from "../wasm/ptr.ts";
import type { VfsMethods } from "./types.ts";
import type { OpenRegistry } from "./io.ts";
import type { ResultCodes } from "./errors.ts";
import { isNotFound } from "./errors.ts";

const encoder = new TextEncoder();

export interface NamespaceDeps {
  readonly sqlite3: Sqlite3;
  readonly open: OpenRegistry;
  readonly rc: ResultCodes;
  readonly ioMethodsPtr: number;
  readonly setPMethods: (pFile: number, ptr: number) => void;
}

/**
 * Maps a `Deno.openSync` option set from the SQLITE_OPEN_* flags. CREATE without
 * EXCLUSIVE is `create`; CREATE with EXCLUSIVE is `createNew` (atomic O_EXCL).
 * `truncate` is never set — SQLite truncates via `xTruncate`, and a truncating
 * open would discard a database SQLite expects to read back.
 */
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

/**
 * Builds the vfs-level callbacks (`xOpen`/`xDelete`/`xAccess`/`xFullPathname`)
 * over Deno's path-based synchronous API. Every callback catches everything and
 * returns a `SQLITE_*` code — a JS throw into SQLite's C is undefined behavior.
 * A path outside the permission grant surfaces as a Deno denial that maps to a
 * result code here; the VFS never widens the grant (see `.claude/rules/security.md`).
 */
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
        const fd = Deno.openSync(path, openOptions(capi, flags));
        open.set(asFile(pFile), {
          fd,
          path,
          deleteOnClose: (flags & capi.SQLITE_OPEN_DELETEONCLOSE) !== 0,
        });
        setPMethods(pFile, ioMethodsPtr);
        if (pOutFlags) wasm.poke32(asOut(pOutFlags), flags);
        return rc.ok;
      } catch {
        return rc.cantOpen;
      }
    },
    xDelete: (_pVfs: number, zName: number, _syncDir: number): number => {
      try {
        const path = nameOf(zName);
        if (path === null) return rc.ok;
        try {
          Deno.removeSync(path);
        } catch (e) {
          if (isNotFound(e)) return rc.ok;
          throw e;
        }
        return rc.ok;
      } catch {
        return rc.ioErrDelete;
      }
    },
    xAccess: (_pVfs: number, zName: number, _flags: number, pResOut: number): number => {
      try {
        const path = nameOf(zName);
        let exists = false;
        if (path !== null) {
          try {
            Deno.statSync(path);
            exists = true;
          } catch (e) {
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
