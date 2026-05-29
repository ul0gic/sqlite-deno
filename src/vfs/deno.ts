import type { Sqlite3 } from "../glue.ts";
import { asIoMethodsArg, asVfsMethodsArg } from "./types.ts";
import { resultCodes } from "./errors.ts";
import { createIoMethods, type OpenRegistry } from "./io.ts";
import { createVfsMethods } from "./namespace.ts";

const VFS_NAME = "deno-fs";
const MAX_PATHNAME = 1024;

/**
 * Registers a file-backed VFS over Deno's synchronous file API against the
 * prebuilt wasm via `installVfs`. All I/O flows out through these callbacks,
 * which reach the filesystem only through path-based `Deno.*Sync` — the wasm has
 * no ambient authority, so the blast radius is exactly the paths the caller
 * granted (see `.claude/rules/security.md`).
 *
 * Single-process scope (DEC-006): locking is a no-op, so the database must be
 * opened by at most one connection in one process. Concurrent access is
 * undefined behavior until Phase 5 adds real locking.
 */
export const installDenoVfs = (sqlite3: Sqlite3): string => {
  const { capi, wasm, struct } = sqlite3;
  if (capi.sqlite3_vfs_find(VFS_NAME)) return VFS_NAME;

  const rc = resultCodes(sqlite3);
  const open: OpenRegistry = new Map();

  const ioMethods = struct.ioMethods();
  ioMethods.$iVersion = 1;
  const io = createIoMethods(sqlite3, open, rc);

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

  const zName = wasm.allocCString(VFS_NAME, false);
  vfsStruct.$zName = zName;
  vfsStruct.addOnDispose(zName);
  sqlite3.vfs.installVfs({ io: { struct: ioMethods, methods: asIoMethodsArg(io) } });
  sqlite3.vfs.installVfs({ vfs: { struct: vfsStruct, methods: asVfsMethodsArg(vfs) } });
  return VFS_NAME;
};

export { VFS_NAME as DENO_VFS_NAME };
