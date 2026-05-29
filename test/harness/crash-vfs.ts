import type { Sqlite3 } from "../../src/glue.ts";
import type { CStrPtr, FilePtr, OutPtr } from "../../src/wasm/ptr.ts";
import type { IoMethods, VfsMethods } from "../../src/vfs/types.ts";
import { asIoMethodsArg, asVfsMethodsArg } from "../../src/vfs/types.ts";
import type { Op } from "./oplog.ts";
import { dirOf, SECTOR_SIZE } from "./oplog.ts";

const INITIAL_CAPACITY = 4096;
const MAX_PATHNAME = 1024;

const isJournal = (name: string): boolean => name.endsWith("-journal");

interface CrashFile {
  data: Uint8Array;
  size: number;
  readonly deleteOnClose: boolean;
  readonly name: string;
  dirSynced: boolean;
}

export interface CrashRecorder {
  readonly name: string;
  readonly ops: readonly Op[];
  readonly reset: () => void;
}

interface CrashVfsConfig {
  readonly vfsName: string;
  readonly realSync: boolean;
  /**
   * When true, model `os_unix.c`'s directory fsyncs: a `dir-sync` op is emitted
   * (a) right after the `-journal`'s first `xSync` (the create-dentry dir-sync,
   * `UNIXFILE_DIRSYNC` riding on the first journal sync — os_unix.c `unixSync`),
   * and (b) right after `xDelete` of the `-journal` when `syncDir & 1` (the
   * commit-point dir-sync — os_unix.c `unixDelete`). This is the VFS-level fix
   * for BUG-001 expressed in pure Deno via `Deno.openSync(dir).syncSync()`.
   */
  readonly dirSync?: boolean;
}

const growTo = (file: CrashFile, needed: number): void => {
  if (needed <= file.data.length) return;
  const next = new Uint8Array(Math.max(needed, file.data.length * 2, INITIAL_CAPACITY));
  next.set(file.data.subarray(0, file.size));
  file.data = next;
};

/**
 * A recording crash-simulation VFS (DEC-007 Layer 3a). It backs files in memory
 * like `src/vfs/memory.ts` so SQLite sees normal I/O during a workload, while
 * appending every mutating op (write/truncate/sync/delete/create) to an ordered
 * write-log with sync barriers. `reconstruct.ts` replays a prefix of that log
 * into a plausible post-crash byte image. `realSync: false` makes `xSync` lie
 * (records a non-durable barrier) for the negative control (DEC-007 §5).
 *
 * Every callback catches everything and returns a `SQLITE_*` code — a JS throw
 * crossing into SQLite's C is undefined behavior (see `.claude/rules/wasm.md`).
 */
export const installCrashVfs = (sqlite3: Sqlite3, cfg: CrashVfsConfig): CrashRecorder => {
  const { capi, wasm, struct } = sqlite3;
  const { vfsName, realSync, dirSync = false } = cfg;

  const files = new Map<string, CrashFile>();
  const open = new Map<FilePtr, CrashFile>();
  let ops: Op[] = [];

  // The wasm hands us bare i32 addresses; brand them at the boundary so an
  // output slot, a C string, and a file pointer can never be transposed.
  const asOut = (p: number): OutPtr => p as OutPtr;
  const asCStr = (p: number): CStrPtr => p as CStrPtr;
  const asFile = (p: number): FilePtr => p as FilePtr;
  const nameOf = (zName: number): string | null => (zName ? wasm.cstrToJs(asCStr(zName)) : null);

  const recorder: CrashRecorder = {
    name: vfsName,
    get ops() {
      return ops;
    },
    reset: () => {
      ops = [];
      files.clear();
      open.clear();
    },
  };

  if (capi.sqlite3_vfs_find(vfsName)) return recorder;

  const ioMethods = struct.ioMethods();
  ioMethods.$iVersion = 1;

  const io = {
    xClose: (pFile: number): number => {
      try {
        const f = open.get(asFile(pFile));
        if (f?.deleteOnClose) {
          files.delete(f.name);
          ops.push({ kind: "delete", file: f.name });
        }
        open.delete(asFile(pFile));
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR;
      }
    },
    xRead: (pFile: number, pDest: number, n: number, offset: bigint): number => {
      try {
        const f = open.get(asFile(pFile));
        if (!f) return capi.SQLITE_IOERR_READ;
        const at = Number(offset);
        const heap = wasm.heap8u();
        const toCopy = Math.min(n, Math.max(0, f.size - at));
        if (toCopy > 0) heap.set(f.data.subarray(at, at + toCopy), pDest);
        if (toCopy < n) {
          heap.fill(0, pDest + toCopy, pDest + n);
          return capi.SQLITE_IOERR_SHORT_READ;
        }
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_READ;
      }
    },
    xWrite: (pFile: number, pSrc: number, n: number, offset: bigint): number => {
      try {
        const f = open.get(asFile(pFile));
        if (!f) return capi.SQLITE_IOERR_WRITE;
        const at = Number(offset);
        const end = at + n;
        const bytes = wasm.heap8u().slice(pSrc, pSrc + n);
        growTo(f, end);
        f.data.set(bytes, at);
        if (end > f.size) f.size = end;
        ops.push({ kind: "write", file: f.name, offset: at, bytes });
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_WRITE;
      }
    },
    xTruncate: (pFile: number, size: bigint): number => {
      try {
        const f = open.get(asFile(pFile));
        if (!f) return capi.SQLITE_IOERR_TRUNCATE;
        f.size = Number(size);
        ops.push({ kind: "truncate", file: f.name, size: f.size });
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_TRUNCATE;
      }
    },
    xSync: (pFile: number, _flags: number): number => {
      try {
        const f = open.get(asFile(pFile));
        if (!f) return capi.SQLITE_IOERR_FSYNC;
        ops.push({ kind: "sync", file: f.name, real: realSync });
        if (dirSync && isJournal(f.name) && !f.dirSynced) {
          f.dirSynced = true;
          ops.push({ kind: "dir-sync", dir: dirOf(f.name), real: realSync });
        }
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_FSYNC;
      }
    },
    xFileSize: (pFile: number, pSize: number): number => {
      try {
        const f = open.get(asFile(pFile));
        if (!f) return capi.SQLITE_IOERR_FSTAT;
        wasm.poke64(asOut(pSize), BigInt(f.size));
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_FSTAT;
      }
    },
    xLock: (_pFile: number, _lockType: number): number => capi.SQLITE_OK,
    xUnlock: (_pFile: number, _lockType: number): number => capi.SQLITE_OK,
    xCheckReservedLock: (_pFile: number, pResOut: number): number => {
      try {
        wasm.poke32(asOut(pResOut), 0);
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR;
      }
    },
    xFileControl: (_pFile: number, _op: number, _pArg: number): number => capi.SQLITE_NOTFOUND,
    xSectorSize: (_pFile: number): number => SECTOR_SIZE,
    xDeviceCharacteristics: (_pFile: number): number => 0,
  } satisfies IoMethods;

  const probe = struct.file();
  const szOsFile = probe.structInfo.sizeof;
  probe.dispose();

  const vfsStruct = struct.vfs();
  vfsStruct.$iVersion = 2;
  vfsStruct.$szOsFile = szOsFile;
  vfsStruct.$mxPathname = MAX_PATHNAME;

  const dfltPtr = capi.sqlite3_vfs_find(null);
  if (dfltPtr) {
    const dflt = struct.vfs(dfltPtr);
    vfsStruct.$xRandomness = dflt.$xRandomness;
    vfsStruct.$xSleep = dflt.$xSleep;
    vfsStruct.$xCurrentTime = dflt.$xCurrentTime;
    vfsStruct.$xCurrentTimeInt64 = dflt.$xCurrentTimeInt64;
    dflt.dispose();
  }

  const vfs = {
    xOpen: (
      _pVfs: number,
      zName: number,
      pFile: number,
      flags: number,
      pOutFlags: number,
    ): number => {
      try {
        const name = nameOf(zName) ?? `:anon:${open.size}`;
        let f = files.get(name);
        if (!f) {
          if (!(flags & capi.SQLITE_OPEN_CREATE)) return capi.SQLITE_CANTOPEN;
          f = {
            data: new Uint8Array(INITIAL_CAPACITY),
            size: 0,
            deleteOnClose: (flags & capi.SQLITE_OPEN_DELETEONCLOSE) !== 0,
            name,
            dirSynced: false,
          };
          files.set(name, f);
          ops.push({ kind: "open-create", file: name });
        }
        open.set(asFile(pFile), f);
        const sq3File = struct.file(pFile);
        sq3File.$pMethods = ioMethods.pointer;
        sq3File.dispose();
        if (pOutFlags) wasm.poke32(asOut(pOutFlags), flags);
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_CANTOPEN;
      }
    },
    xDelete: (_pVfs: number, zName: number, syncDir: number): number => {
      try {
        const name = nameOf(zName);
        if (name !== null) {
          files.delete(name);
          ops.push({ kind: "delete", file: name });
          if (dirSync && (syncDir & 1) !== 0) {
            ops.push({ kind: "dir-sync", dir: dirOf(name), real: realSync });
          }
        }
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_DELETE;
      }
    },
    xAccess: (_pVfs: number, zName: number, _flags: number, pResOut: number): number => {
      try {
        const name = nameOf(zName);
        wasm.poke32(asOut(pResOut), name !== null && files.has(name) ? 1 : 0);
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR;
      }
    },
    xFullPathname: (_pVfs: number, zName: number, nOut: number, zOut: number): number => {
      try {
        return wasm.cstrncpy(asOut(zOut), asCStr(zName), nOut) < nOut
          ? capi.SQLITE_OK
          : capi.SQLITE_CANTOPEN;
      } catch {
        return capi.SQLITE_CANTOPEN;
      }
    },
  } satisfies VfsMethods;

  const zName = wasm.allocCString(vfsName, false);
  vfsStruct.$zName = zName;
  vfsStruct.addOnDispose(zName);
  sqlite3.vfs.installVfs({ io: { struct: ioMethods, methods: asIoMethodsArg(io) } });
  sqlite3.vfs.installVfs({ vfs: { struct: vfsStruct, methods: asVfsMethodsArg(vfs) } });
  return recorder;
};
