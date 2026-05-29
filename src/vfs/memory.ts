import type { Sqlite3 } from "../glue.ts";
import type { CStrPtr, FilePtr, OutPtr } from "../wasm/ptr.ts";
import type { IoMethods, VfsMethods } from "./types.ts";
import { asIoMethodsArg, asVfsMethodsArg } from "./types.ts";

const VFS_NAME = "deno-mem";
const INITIAL_CAPACITY = 4096;
const SECTOR_SIZE = 4096;
const MAX_PATHNAME = 512;

interface MemFile {
  data: Uint8Array;
  size: number;
  readonly deleteOnClose: boolean;
  readonly name: string;
}

const growTo = (file: MemFile, needed: number): void => {
  if (needed <= file.data.length) return;
  const next = new Uint8Array(Math.max(needed, file.data.length * 2, INITIAL_CAPACITY));
  next.set(file.data.subarray(0, file.size));
  file.data = next;
};

/**
 * A trivial single-process, in-memory VFS registered against the prebuilt wasm
 * via `installVfs`. Its purpose is to prove the JS↔WASM VFS boundary end to end;
 * it does no real I/O, so there is no permission surface and no FS at all.
 *
 * Every callback catches everything and returns a `SQLITE_*` code — a JS throw
 * crossing into SQLite's C is undefined behavior (see `.claude/rules/wasm.md`).
 */
export const installMemoryVfs = (sqlite3: Sqlite3): string => {
  const { capi, wasm, struct } = sqlite3;
  if (capi.sqlite3_vfs_find(VFS_NAME)) return VFS_NAME;

  const files = new Map<string, MemFile>();
  const open = new Map<FilePtr, MemFile>();

  // The wasm hands us bare i32 addresses; brand them at the boundary so an
  // output slot, a C string, and a file pointer can never be transposed.
  const asOut = (p: number): OutPtr => p as OutPtr;
  const asCStr = (p: number): CStrPtr => p as CStrPtr;
  const asFile = (p: number): FilePtr => p as FilePtr;

  const nameOf = (zName: number): string | null => (zName ? wasm.cstrToJs(asCStr(zName)) : null);

  const ioMethods = struct.ioMethods();
  ioMethods.$iVersion = 1;

  const io = {
    xClose: (pFile: number): number => {
      try {
        const f = open.get(asFile(pFile));
        if (f?.deleteOnClose) files.delete(f.name);
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
        // Re-acquire the heap view on every call — it detaches if memory grows.
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
        growTo(f, end);
        f.data.set(wasm.heap8u().subarray(pSrc, pSrc + n), at);
        if (end > f.size) f.size = end;
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
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_TRUNCATE;
      }
    },
    xSync: (_pFile: number, _flags: number): number => capi.SQLITE_OK,
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
          };
          files.set(name, f);
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
    xDelete: (_pVfs: number, zName: number, _syncDir: number): number => {
      try {
        const name = nameOf(zName);
        if (name !== null) files.delete(name);
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

  const zName = wasm.allocCString(VFS_NAME, false);
  vfsStruct.$zName = zName;
  vfsStruct.addOnDispose(zName);
  sqlite3.vfs.installVfs({ io: { struct: ioMethods, methods: asIoMethodsArg(io) } });
  sqlite3.vfs.installVfs({ vfs: { struct: vfsStruct, methods: asVfsMethodsArg(vfs) } });
  return VFS_NAME;
};

export { VFS_NAME as MEMORY_VFS_NAME };
