import type { Sqlite3 } from "../glue.ts";
import type { FilePtr, OutPtr } from "../wasm/ptr.ts";
import type { OpenRegistry } from "./io.ts";
import type { ResultCodes } from "./errors.ts";

/** The X-strict lock ladder of `IoMethods`. */
export interface LockMethods {
  readonly xLock: (pFile: number, lockType: number) => number;
  readonly xUnlock: (pFile: number, lockType: number) => number;
  readonly xCheckReservedLock: (pFile: number, pResOut: number) => number;
}

/** Mode 1 X-strict `flock` ladder: always `LOCK_EX`, never `LOCK_SH`, so no
 * upgrade hazard (DEC-009, BUG-002) at the cost of serialized multi-process access. */
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
        // X-strict holds only LOCK_EX, so no peer ever holds RESERVED to report;
        // recovery is gated by xLock(SHARED)'s LOCK_EX, not this probe (DEC-009).
        if (!open.has(asFile(pFile))) return rc.ioErrCheckReservedLock;
        wasm.poke32(asOut(pResOut), 0);
        return rc.ok;
      } catch {
        return rc.ioErrCheckReservedLock;
      }
    },
  } satisfies LockMethods;
};
