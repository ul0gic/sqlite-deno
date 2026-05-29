import type { sqlite3_file, sqlite3_io_methods, sqlite3_vfs } from "./index.d.mts";

/**
 * The SQLite struct binder generates `$`-prefixed accessors for every C member
 * at runtime, but the upstream `.d.mts` models only a subset and JSR forbids the
 * ambient-module augmentation that would add the rest. Each view extends the
 * upstream struct type and adds only the missing `$` members, so it stays
 * assignable to `installVfs` while typing the accessors our VFS sets. One
 * reinterpret per instance lives in `glue.ts`.
 */

export interface IoMethodsStruct extends sqlite3_io_methods {
  $iVersion: number;
}

export interface VfsStruct extends sqlite3_vfs {
  $xRandomness: number;
  $xSleep: number;
  $xCurrentTime: number;
  $xCurrentTimeInt64: number;
}

export type FileStruct = sqlite3_file;
