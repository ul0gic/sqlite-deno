import type { Sqlite3Static } from "../wasm/sqlite3.d.ts";

type IoMethodsArg = NonNullable<Parameters<Sqlite3Static["vfs"]["installVfs"]>[0]["io"]>["methods"];
type VfsMethodsArg = NonNullable<
  Parameters<Sqlite3Static["vfs"]["installVfs"]>[0]["vfs"]
>["methods"];

/** Actual runtime io-methods: i64 params arrive as `bigint`; `xSectorSize` returns a plain int, not a result code (diverges from upstream `.d.mts`). */
export interface IoMethods {
  readonly xClose: (pFile: number) => number;
  readonly xRead: (pFile: number, pDest: number, n: number, offset: bigint) => number;
  readonly xWrite: (pFile: number, pSrc: number, n: number, offset: bigint) => number;
  readonly xTruncate: (pFile: number, size: bigint) => number;
  readonly xSync: (pFile: number, flags: number) => number;
  readonly xFileSize: (pFile: number, pSize: number) => number;
  readonly xLock: (pFile: number, lockType: number) => number;
  readonly xUnlock: (pFile: number, lockType: number) => number;
  readonly xCheckReservedLock: (pFile: number, pResOut: number) => number;
  readonly xFileControl: (pFile: number, op: number, pArg: number) => number;
  readonly xSectorSize: (pFile: number) => number;
  readonly xDeviceCharacteristics: (pFile: number) => number;
}

export interface VfsMethods {
  readonly xOpen: (
    pVfs: number,
    zName: number,
    pFile: number,
    flags: number,
    pOutFlags: number,
  ) => number;
  readonly xDelete: (pVfs: number, zName: number, syncDir: number) => number;
  readonly xAccess: (pVfs: number, zName: number, flags: number, pResOut: number) => number;
  readonly xFullPathname: (pVfs: number, zName: number, nOut: number, zOut: number) => number;
}

// Boundary cast: installMethods only reads the function values, reconciling the
// accurate runtime types with upstream's i64-as-number, result-union signature.
export const asIoMethodsArg = (m: IoMethods): IoMethodsArg => m as unknown as IoMethodsArg;
export const asVfsMethodsArg = (m: VfsMethods): VfsMethodsArg => m as unknown as VfsMethodsArg;
