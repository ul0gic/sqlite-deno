import type { Sqlite3 } from "../../src/glue.ts";
import type { FilePtr, OutPtr } from "../../src/wasm/ptr.ts";
import { asIoMethodsArg, asVfsMethodsArg } from "../../src/vfs/types.ts";
import type { IoMethods } from "../../src/vfs/types.ts";
import { resultCodes } from "../../src/vfs/errors.ts";
import { createIoMethods, type OpenRegistry } from "../../src/vfs/io.ts";
import { createVfsMethods } from "../../src/vfs/namespace.ts";

export const LOCKING_MODES = ["xstrict", "defeated"] as const;
export type LockingMode = (typeof LOCKING_MODES)[number];

const isLockingMode = (v: string): v is LockingMode =>
  (LOCKING_MODES as readonly string[]).includes(v);

export const parseLockingMode = (v: string): LockingMode => {
  if (isLockingMode(v)) return v;
  throw new Error(`unknown locking mode: ${v}`);
};

const MAX_PATHNAME = 1024;

/**
 * Registers a Mode-1 VFS that reuses the real `createIoMethods`/`createVfsMethods`
 * but lets the harness pick the lock protocol. `xstrict` is the shipped DEC-009
 * ladder verbatim (real `xLock`/`xUnlock`/`xCheckReservedLock`); `defeated` swaps
 * only those three callbacks for no-ops, reproducing the Phase-3
 * concurrent-unsynchronized-writers behaviour that is the mandatory negative
 * control. `src/` is never touched — the override wraps the public `IoMethods`
 * object after `createIoMethods` builds it, so the no-op seam exists solely in
 * test code (DEC-009 negative-control discipline).
 *
 * Each mode gets a distinct VFS name so a process can register either without
 * the `sqlite3_vfs_find` early-return colliding.
 */
export const installModeVfs = (sqlite3: Sqlite3, mode: LockingMode): string => {
  const vfsName = `deno-fs-conc-${mode}`;
  const { capi, wasm, struct } = sqlite3;
  if (capi.sqlite3_vfs_find(vfsName)) return vfsName;

  const rc = resultCodes(sqlite3);
  const open: OpenRegistry = new Map();

  const asFile = (p: number): FilePtr => p as FilePtr;
  const asOut = (p: number): OutPtr => p as OutPtr;

  const ioMethods = struct.ioMethods();
  ioMethods.$iVersion = 1;
  const realIo = createIoMethods(sqlite3, open, rc);
  const io: IoMethods = mode === "defeated"
    ? {
      ...realIo,
      xLock: (pFile: number, _lockType: number): number =>
        open.has(asFile(pFile)) ? rc.ok : rc.ioErrLock,
      xUnlock: (pFile: number, _lockType: number): number =>
        open.has(asFile(pFile)) ? rc.ok : rc.ioErrUnlock,
      xCheckReservedLock: (pFile: number, pResOut: number): number => {
        if (!open.has(asFile(pFile))) return rc.ioErrCheckReservedLock;
        wasm.poke32(asOut(pResOut), 0);
        return rc.ok;
      },
    }
    : realIo;

  const probe = struct.file();
  const szOsFile = probe.structInfo.sizeof;
  probe.dispose();

  const setPMethods = (pFile: number, ptr: number): void => {
    const sq3File = struct.file(pFile);
    sq3File.$pMethods = ptr;
    sq3File.dispose();
  };

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

  const vfs = createVfsMethods({
    sqlite3,
    open,
    rc,
    ioMethodsPtr: ioMethods.pointer,
    setPMethods,
  });

  const zName = wasm.allocCString(vfsName, false);
  vfsStruct.$zName = zName;
  vfsStruct.addOnDispose(zName);
  sqlite3.vfs.installVfs({ io: { struct: ioMethods, methods: asIoMethodsArg(io) } });
  sqlite3.vfs.installVfs({ vfs: { struct: vfsStruct, methods: asVfsMethodsArg(vfs) } });
  return vfsName;
};
