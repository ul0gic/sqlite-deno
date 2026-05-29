import type { Sqlite3Static } from "../wasm/sqlite3.d.ts";

type IoMethodsArg = NonNullable<Parameters<Sqlite3Static["vfs"]["installVfs"]>[0]["io"]>["methods"];
type VfsMethodsArg = NonNullable<
  Parameters<Sqlite3Static["vfs"]["installVfs"]>[0]["vfs"]
>["methods"];

/**
 * The runtime contract for the io-methods callbacks. It diverges from the
 * upstream `.d.mts` in two verified ways: i64 parameters (`offset`, `size`)
 * arrive as `bigint` (the build enables BigInt), and methods like `xSectorSize`
 * return a plain integer, not a `SQLITE_*` result code. We model what actually
 * crosses the boundary.
 */
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

// The upstream method types mis-state i64 params as `number` and constrain
// returns to the `Sqlite3Result` union; `installMethods` only reads the function
// values, so a cast at this boundary reconciles our accurate runtime types with
// the installer's signature.
export const asIoMethodsArg = (m: IoMethods): IoMethodsArg => m as unknown as IoMethodsArg;
export const asVfsMethodsArg = (m: VfsMethods): VfsMethodsArg => m as unknown as VfsMethodsArg;
