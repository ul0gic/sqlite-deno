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

/** True when `path` has no directory entry — i.e. an open with CREATE would create one. */
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
        // Canonicalize-then-recheck before any open touches the filesystem: Deno
        // follows a symlink whose target escapes the grant (SEC-001), so refuse
        // an escaped target here, before a create can land an empty file outside
        // the grant. Covers every file the VFS opens — journal and wal are opened
        // lazily mid-operation and pass through this same gate.
        if (!isGranted(guardOpen(sqlite3, path, flags))) return rc.cantOpen;
        // os_unix.c sets UNIXFILE_DIRSYNC only when this open creates the dentry;
        // pre-stat under a CREATE flag so the first xSync makes that dentry durable.
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
        // Canonicalize the parent dir before unlinking: a removeSync through an
        // in-grant directory symlink lands the unlink on an out-of-grant target
        // (SEC-003). The final component is checked lexically — unlink removes the
        // link itself, never its target, so a legitimate in-grant final symlink is
        // not over-refused; only a symlinked directory component escapes.
        if (!isGranted(guardPath(dirname(path), "write"))) return rc.ioErrDelete;
        try {
          Deno.removeSync(path);
        } catch (e) {
          if (isNotFound(e)) return rc.ok;
          throw e;
        }
        // os_unix.c fsyncs the parent dir after a commit-point unlink so the
        // removed dentry is durable (the BUG-001 fix; DEC-008).
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
        // statSync follows the final symlink and returns the target's metadata, so
        // an in-grant symlink to an out-of-grant file would leak its existence/size
        // (SEC-003). Canonicalize the full path and report not-accessible (the
        // contract's `pResOut = 0`) when it escapes — never the out-of-grant truth.
        if (path !== null && isGranted(guardPath(path, "read"))) {
          try {
            Deno.statSync(path);
            exists = true;
          } catch (e) {
            // Only a NotFound is "does not exist" → pResOut = 0. Any other stat
            // failure (a real PermissionDenied at the FS, a transient I/O error)
            // means existence is *undeterminable* — fail closed with
            // SQLITE_IOERR_ACCESS, never a false "absent": a false absent on a hot
            // -journal/-wal makes SQLite skip recovery and run on a torn database
            // (DEC-006 §5, mirrors os_unix.c unixAccess: non-ENOENT → IOERR_ACCESS).
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
        // An absolute path is returned normalized untouched; a relative one is
        // anchored to the process cwd — @std/path `resolve` consults `Deno.cwd()`
        // only on the relative branch (DBT-002, DEC-006 §6). The package expects
        // absolute db paths (the public API and oo1.DB pass them), so the ambient
        // cwd anchor is a documented fallback, never the hot path. `Deno.cwd()` is
        // grant-free on the supported Deno; a future runtime gating it behind
        // --allow-read would surface as a CANTOPEN on this branch only — do not
        // "simplify" this into a path that assumes cwd is always free.
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
