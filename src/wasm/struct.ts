import type { sqlite3_file, sqlite3_io_methods, sqlite3_vfs } from "./index.d.mts";

// Upstream `.d.mts` models only a subset of the runtime `$` accessors and JSR
// forbids ambient augmentation; each view adds the missing members it sets.

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
