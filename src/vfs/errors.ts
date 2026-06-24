import type { Sqlite3 } from "../glue.ts";

/**
 * The result-code constants the VFS hands back across the C boundary. Pulled
 * from `capi` once at install time so the hot path indexes a closed-over record
 * instead of reaching through the binding object per call.
 */
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

/**
 * True iff `e` is a Windows whole-file-lock contention error — a read/write
 * syscall refused because a *peer* connection holds the `LockFileEx` lock the
 * X-strict ladder takes (DEC-009).
 *
 * Why this exists: on Windows file locks are mandatory, not advisory like POSIX
 * `flock`. Native SQLite (`os_win.c`) sidesteps this by byte-range-locking only
 * the `PENDING_BYTE` region past EOF, so a header read never collides; our VFS
 * locks the whole file via Deno's `lockSync`, so a peer's `xRead` of the header
 * hits `ERROR_LOCK_VIOLATION` (os error 33) / `ERROR_SHARING_VIOLATION` (32)
 * before SQLite's lock protocol can report contention. Deno surfaces it as a
 * bare `Error` (no typed `Deno.errors.*` subclass) carrying `code === "EBUSY"`
 * (probe-confirmed, Deno 2.8.3) — `code` is the robust discriminator; the os
 * error number is a localized-message belt-and-suspenders fallback. Mapping it
 * to `SQLITE_BUSY` lets SQLite surface a clean retryable busy on the read path,
 * matching the POSIX flock contract (BUG-006).
 *
 * Strictly scoped to lock contention: a genuine read failure (bad sector,
 * truncated file, permission) carries a different `code`/os error and STILL
 * surfaces as `SQLITE_IOERR_READ` — masking a real I/O error as "busy, retry"
 * would be a corruption footgun, so this never widens past `EBUSY`+(33|32).
 */
const LOCK_VIOLATION_OS_ERRORS = new Set([33, 32]);

export const isWindowsLockContention = (e: unknown): boolean => {
  if (Deno.build.os !== "windows") return false;
  if (!(e instanceof Error)) return false;
  // Deno tags lock/sharing violations with the libuv code "EBUSY"; prefer the
  // structured property over scraping the localized message.
  const code: unknown = (e as { code?: unknown }).code;
  if (code === "EBUSY") return true;
  const m = /\(os error (\d+)\)/.exec(e.message);
  return m !== null && LOCK_VIOLATION_OS_ERRORS.has(Number(m[1]));
};
