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

/**
 * A live file the VFS holds open. One `FsFile` backs exactly one
 * `sqlite3_file*`; it is never shared, because Deno has no positional
 * pread/pwrite and the VFS drives a shared seek offset — a second user of the
 * same handle would tear reads (see issue QA-001).
 *
 * `dirSyncPending` is `os_unix.c`'s `UNIXFILE_DIRSYNC` latch: set in `xOpen`
 * when this open created the file's directory entry, consumed on the first
 * `xSync` to make that dentry durable (DEC-008).
 *
 * `lockLevel` is the SQLite lock state (`SQLITE_LOCK_NONE`…`_EXCLUSIVE`) this
 * open believes it holds. The physical whole-file `LOCK_EX` is held iff
 * `lockLevel >= SQLITE_LOCK_SHARED` — the X-strict ladder of DEC-009.
 */
export interface OpenFile {
  readonly fd: Deno.FsFile;
  readonly path: string;
  readonly deleteOnClose: boolean;
  dirSyncPending: boolean;
  lockLevel: number;
}

/**
 * fsyncs the directory `dir` so a child's create/unlink dentry is durable —
 * `Deno.openSync(dir, { read: true }).syncSync()` is a real directory fsync
 * (strace-verified: `openat(O_RDONLY)` + `fsync`; DEC-008). Opening the parent
 * dir needs a read grant on the dir itself — a file-only grant does NOT cover
 * it (ENH-002); the denial fails closed as a result code and never widens the
 * grant. The handle is closed on every path.
 *
 * Canonicalize-then-recheck before the open: an in-grant directory symlink whose
 * target escapes the grant would otherwise fsync an out-of-grant dir (SEC-003).
 * A non-granted target throws — the caller's try/catch maps it to the op's IOERR,
 * fail-closed, exactly as an `openSync` denial already does. The legitimate
 * caller's dir is the db's own (already approved at open), so this never fires on
 * the durability path; it only stops an escaped dir.
 *
 * Windows: a no-op. `syncSync` maps to `FlushFileBuffers`, which rejects
 * directory handles with `ERROR_ACCESS_DENIED` (os error 5) by design — NTFS
 * makes dentry ops (create/rename/unlink) durable via its own metadata journal,
 * so there is no Win32 primitive to flush a directory. `os_win.c`'s `winSync`
 * never fsyncs directories either; dir-fsync is a Unix-only construct (DEC-013).
 * Returning before any filesystem I/O is why the grant guard is skipped here:
 * nothing touches `dir`, so there is no out-of-grant access to refuse.
 */
export const syncDir = (dir: string): void => {
  if (Deno.build.os === "windows") return;
  if (!isGranted(guardPath(dir, "write"))) throw new Error("dir fsync target escapes the grant");
  using dirFd = Deno.openSync(dir, { read: true });
  dirFd.syncSync();
};

export type OpenRegistry = Map<FilePtr, OpenFile>;

/**
 * Copies `n` bytes of wasm heap, starting at `src`, into a fresh JS buffer. The
 * heap view is read once here and never retained — it detaches if wasm memory
 * grows, so a stale view would silently read someone else's bytes.
 */
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

/**
 * Reads up to `buf.length` bytes from the current offset, looping over short
 * counts. Returns the number of bytes actually read; a count below the request
 * (including 0 on immediate EOF) is a short read the caller must zero-fill.
 */
const readUpTo = (fd: Deno.FsFile, buf: Uint8Array): number => {
  let read = 0;
  while (read < buf.length) {
    const n = fd.readSync(buf.subarray(read));
    if (n === null || n === 0) break;
    read += n;
  }
  return read;
};

/**
 * Builds the `sqlite3_io_methods` callbacks over Deno's synchronous file API.
 * Every callback catches everything and returns a `SQLITE_*` code — a JS throw
 * crossing into SQLite's C is undefined behavior (see `.claude/rules/wasm.md`).
 * Locking is the X-strict whole-file `flock` ladder (`./lock.ts`, DEC-009);
 * `xDeviceCharacteristics` returns 0 — claiming any IOCAP bit on an arbitrary
 * filesystem corrupts.
 */
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
        // A peer's whole-file Windows lock blocks this read before SQLite's lock
        // protocol can report contention; surface a retryable BUSY, not IOERR
        // (BUG-006). Genuine read failures still fall through to IOERR_READ.
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
        // Symmetric to xRead: a peer's whole-file Windows lock blocks this write
        // as contention, not a real I/O fault — surface a retryable BUSY (BUG-006).
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
