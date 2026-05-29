/** Package version; release tooling keeps this in lockstep with `deno.json`. */
export const VERSION = "0.0.0";

export { loadSqlite3 } from "./glue.ts";
export type { Sqlite3, Sqlite3Static } from "./glue.ts";
export { installMemoryVfs, MEMORY_VFS_NAME } from "./vfs/memory.ts";
export { DENO_VFS_NAME, installDenoVfs } from "./vfs/deno.ts";
