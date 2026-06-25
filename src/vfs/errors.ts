import type { Sqlite3 } from "../glue.ts";

/** Result codes the VFS returns across the C boundary, snapshotted from `capi` at install time. */
export interface ResultCodes {
  readonly ok: number;
  readonly cantOpen: number;
  readonly ioErr: number;
  readonly ioErrRead: number;
  readonly ioErrShortRead: number;
  readonly ioErrWrite: number;
  readonly ioErrFsync: number;
  readonly ioErrTruncate: number;
  readonly ioErrFstat: number;
  readonly ioErrClose: number;
  readonly ioErrDelete: number;
  readonly ioErrAccess: number;
  readonly busy: number;
  readonly ioErrLock: number;
  readonly ioErrUnlock: number;
  readonly ioErrCheckReservedLock: number;
}

export const resultCodes = ({ capi }: Sqlite3): ResultCodes => ({
  ok: capi.SQLITE_OK,
  cantOpen: capi.SQLITE_CANTOPEN,
  ioErr: capi.SQLITE_IOERR,
  ioErrRead: capi.SQLITE_IOERR_READ,
  ioErrShortRead: capi.SQLITE_IOERR_SHORT_READ,
  ioErrWrite: capi.SQLITE_IOERR_WRITE,
  ioErrFsync: capi.SQLITE_IOERR_FSYNC,
  ioErrTruncate: capi.SQLITE_IOERR_TRUNCATE,
  ioErrFstat: capi.SQLITE_IOERR_FSTAT,
  ioErrClose: capi.SQLITE_IOERR_CLOSE,
  ioErrDelete: capi.SQLITE_IOERR_DELETE,
  ioErrAccess: capi.SQLITE_IOERR_ACCESS,
  busy: capi.SQLITE_BUSY,
  ioErrLock: capi.SQLITE_IOERR_LOCK,
  ioErrUnlock: capi.SQLITE_IOERR_UNLOCK,
  ioErrCheckReservedLock: capi.SQLITE_IOERR_CHECKRESERVEDLOCK,
});

/** A target path that does not exist — distinguishes idempotent delete from a real I/O failure. */
export const isNotFound = (e: unknown): boolean => e instanceof Deno.errors.NotFound;

// Windows mandatory whole-file locks make a peer's header read collide; map only that
// contention to SQLITE_BUSY, never a genuine read failure (DEC-009, BUG-006).
const LOCK_VIOLATION_OS_ERRORS = new Set([33, 32]);

export const isWindowsLockContention = (e: unknown): boolean => {
  if (Deno.build.os !== "windows") return false;
  if (!(e instanceof Error)) return false;
  const code: unknown = (e as { code?: unknown }).code;
  if (code === "EBUSY") return true;
  const m = /\(os error (\d+)\)/.exec(e.message);
  return m !== null && LOCK_VIOLATION_OS_ERRORS.has(Number(m[1]));
};
