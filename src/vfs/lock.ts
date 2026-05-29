import type { Sqlite3 } from "../glue.ts";
import type { FilePtr, OutPtr } from "../wasm/ptr.ts";
import type { OpenRegistry } from "./io.ts";
import type { ResultCodes } from "./errors.ts";

/** The X-strict lock ladder (`xLock`/`xUnlock`/`xCheckReservedLock`) of `IoMethods`. */
export interface LockMethods {
  readonly xLock: (pFile: number, lockType: number) => number;
  readonly xUnlock: (pFile: number, lockType: number) => number;
  readonly xCheckReservedLock: (pFile: number, pResOut: number) => number;
}

/**
 * Builds the Mode 1 lock ladder over whole-file `flock`, X-strict (DEC-009):
 * exactly `os_unix.c`'s `flockLock`/`flockUnlock`/`flockCheckReservedLock`. The
 * VFS holds `LOCK_EX` for ANY lock level ≥ SHARED and NEVER holds `LOCK_SH` —
 * so there is no upgrade path and the non-atomic-`flock`-upgrade hazard
 * (BUG-002) is structurally unreachable. The cost is no concurrent readers:
 * multi-process *serialized* access, one accessor at a time.
 *
 * `tryLockSync` is non-blocking by design — `lockSync` would hang the
 * single-threaded event loop and is forbidden (DEC-009). A lock *conflict*
 * (another connection holds `LOCK_EX`) returns `SQLITE_BUSY`, the signal
 * SQLite's busy-handler retries on; a `flock` syscall *throw* maps to
 * `SQLITE_IOERR_LOCK`/`_UNLOCK` and never crosses into C (`.claude/rules/wasm.md`).
 */
export const createLockMethods = (
  sqlite3: Sqlite3,
  open: OpenRegistry,
  rc: ResultCodes,
): LockMethods => {
  const { capi, wasm } = sqlite3;
  const LOCK_NONE = capi.SQLITE_LOCK_NONE;
  const asFile = (p: number): FilePtr => p as FilePtr;
  const asOut = (p: number): OutPtr => p as OutPtr;

  return {
    xLock: (pFile: number, lockType: number): number => {
      try {
        const f = open.get(asFile(pFile));
        if (!f) return rc.ioErrLock;
        if (lockType <= f.lockLevel) return rc.ok;
        if (f.lockLevel > LOCK_NONE) {
          f.lockLevel = lockType;
          return rc.ok;
        }
        if (!f.fd.tryLockSync(true)) return rc.busy;
        f.lockLevel = lockType;
        return rc.ok;
      } catch {
        return rc.ioErrLock;
      }
    },
    xUnlock: (pFile: number, lockType: number): number => {
      try {
        const f = open.get(asFile(pFile));
        if (!f) return rc.ioErrUnlock;
        if (lockType >= f.lockLevel) return rc.ok;
        // flockUnlock keeps LOCK_EX until NONE; SHARED is a pure state downgrade.
        if (lockType > LOCK_NONE) {
          f.lockLevel = lockType;
          return rc.ok;
        }
        f.fd.unlockSync();
        f.lockLevel = LOCK_NONE;
        return rc.ok;
      } catch {
        return rc.ioErrUnlock;
      }
    },
    xCheckReservedLock: (pFile: number, pResOut: number): number => {
      try {
        // X-strict only ever holds LOCK_EX — fully mutually exclusive, so no
        // peer ever holds a RESERVED lock to report. Hot-journal recovery is
        // gated by the LOCK_EX that xLock(SHARED) takes, not by this probe
        // (DEC-009). Do not "fix" this to probe the file.
        if (!open.has(asFile(pFile))) return rc.ioErrCheckReservedLock;
        wasm.poke32(asOut(pResOut), 0);
        return rc.ok;
      } catch {
        return rc.ioErrCheckReservedLock;
      }
    },
  } satisfies LockMethods;
};
