import { dirname } from "@std/path";
import type { Sqlite3 } from "../glue.ts";
import type { FilePtr, OutPtr } from "../wasm/ptr.ts";
import type { IoMethods } from "./types.ts";
import type { ResultCodes } from "./errors.ts";
import { createLockMethods } from "./lock.ts";
import { isWindowsLockContention } from "./errors.ts";
import { guardPath, isGranted } from "./guard.ts";

const SECTOR_SIZE = 4096;
const SYNC_DATAONLY = 0x10;

/** One `FsFile` per `sqlite3_file*`, never shared: Deno has no pread/pwrite, so a
 * shared seek offset would tear reads (QA-001). `dirSyncPending`: DEC-008. `lockLevel`: DEC-009. */
export interface OpenFile {
  readonly fd: Deno.FsFile;
  readonly path: string;
  readonly deleteOnClose: boolean;
  dirSyncPending: boolean;
  lockLevel: number;
}

/** fsyncs `dir` for child-dentry durability (DEC-008); Windows no-op (DEC-013). Guard-rechecks
 * before open so an in-grant symlink can't fsync an escaped dir (SEC-003). */
export const syncDir = (dir: string): void => {
  if (Deno.build.os === "windows") return;
  if (!isGranted(guardPath(dir, "write"))) throw new Error("dir fsync target escapes the grant");
  using dirFd = Deno.openSync(dir, { read: true });
  dirFd.syncSync();
};

export type OpenRegistry = Map<FilePtr, OpenFile>;

/** Copies into a fresh buffer; the heap view is never retained — it detaches on wasm growth. */
const heapSlice = (sqlite3: Sqlite3, src: number, n: number): Uint8Array =>
  sqlite3.wasm.heap8u().slice(src, src + n);

const writeAll = (fd: Deno.FsFile, buf: Uint8Array): void => {
  let written = 0;
  while (written < buf.length) {
    const n = fd.writeSync(buf.subarray(written));
    if (n <= 0) throw new Error("short write");
    written += n;
  }
};

/** Returns bytes read; below `buf.length` (0 on EOF) is a short read the caller zero-fills. */
const readUpTo = (fd: Deno.FsFile, buf: Uint8Array): number => {
  let read = 0;
  while (read < buf.length) {
    const n = fd.readSync(buf.subarray(read));
    if (n === null || n === 0) break;
    read += n;
  }
  return read;
};

/** Every callback catches all and returns a `SQLITE_*` code — a JS throw into C is UB (wasm.md).
 * `xDeviceCharacteristics` returns 0: claiming an IOCAP bit on an arbitrary filesystem corrupts. */
export const createIoMethods = (
  sqlite3: Sqlite3,
  open: OpenRegistry,
  rc: ResultCodes,
): IoMethods => {
  const { wasm } = sqlite3;
  const asFile = (p: number): FilePtr => p as FilePtr;
  const asOut = (p: number): OutPtr => p as OutPtr;
  const lock = createLockMethods(sqlite3, open, rc);

  return {
    xClose: (pFile: number): number => {
      try {
        const f = open.get(asFile(pFile));
        open.delete(asFile(pFile));
        if (!f) return rc.ok;
        f.fd.close();
        if (f.deleteOnClose) {
          try {
            Deno.removeSync(f.path);
          } catch { /* delete-on-close is best-effort cleanup; the close itself succeeded */ }
        }
        return rc.ok;
      } catch {
        return rc.ioErrClose;
      }
    },
    xRead: (pFile: number, pDest: number, n: number, offset: bigint): number => {
      try {
        const f = open.get(asFile(pFile));
        if (!f) return rc.ioErrRead;
        f.fd.seekSync(offset, Deno.SeekMode.Start);
        const staging = new Uint8Array(n);
        const got = readUpTo(f.fd, staging);
        const heap = wasm.heap8u();
        heap.set(staging.subarray(0, got), pDest);
        if (got < n) {
          heap.fill(0, pDest + got, pDest + n);
          return rc.ioErrShortRead;
        }
        return rc.ok;
      } catch (e) {
        // A peer's Windows lock blocks the read as contention, not an I/O fault — BUSY (BUG-006).
        if (isWindowsLockContention(e)) return rc.busy;
        return rc.ioErrRead;
      }
    },
    xWrite: (pFile: number, pSrc: number, n: number, offset: bigint): number => {
      try {
        const f = open.get(asFile(pFile));
        if (!f) return rc.ioErrWrite;
        const staging = heapSlice(sqlite3, pSrc, n);
        f.fd.seekSync(offset, Deno.SeekMode.Start);
        writeAll(f.fd, staging);
        return rc.ok;
      } catch (e) {
        // Symmetric to xRead: a peer's Windows lock blocks the write as contention, BUSY (BUG-006).
        if (isWindowsLockContention(e)) return rc.busy;
        return rc.ioErrWrite;
      }
    },
    xTruncate: (pFile: number, size: bigint): number => {
      try {
        const f = open.get(asFile(pFile));
        if (!f) return rc.ioErrTruncate;
        f.fd.truncateSync(Number(size));
        return rc.ok;
      } catch {
        return rc.ioErrTruncate;
      }
    },
    xSync: (pFile: number, flags: number): number => {
      try {
        const f = open.get(asFile(pFile));
        if (!f) return rc.ioErrFsync;
        if ((flags & SYNC_DATAONLY) !== 0) f.fd.syncDataSync();
        else f.fd.syncSync();
        if (f.dirSyncPending) {
          f.dirSyncPending = false;
          syncDir(dirname(f.path));
        }
        return rc.ok;
      } catch {
        return rc.ioErrFsync;
      }
    },
    xFileSize: (pFile: number, pSize: number): number => {
      try {
        const f = open.get(asFile(pFile));
        if (!f) return rc.ioErrFstat;
        wasm.poke64(asOut(pSize), BigInt(f.fd.statSync().size));
        return rc.ok;
      } catch {
        return rc.ioErrFstat;
      }
    },
    xLock: lock.xLock,
    xUnlock: lock.xUnlock,
    xCheckReservedLock: lock.xCheckReservedLock,
    xFileControl: (_pFile: number, _op: number, _pArg: number): number =>
      sqlite3.capi.SQLITE_NOTFOUND,
    xSectorSize: (_pFile: number): number => SECTOR_SIZE,
    xDeviceCharacteristics: (_pFile: number): number => 0,
  } satisfies IoMethods;
};
