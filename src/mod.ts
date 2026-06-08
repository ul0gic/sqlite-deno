/** Package version; release tooling keeps this in lockstep with `deno.json`. */
export const VERSION = "0.0.0";

export { openDatabase } from "./database.ts";
export type { Database, OpenMode, OpenOptions } from "./database.ts";
export type { RunResult, Statement } from "./statement.ts";
export type { Transaction } from "./transaction.ts";
export type { SqlValue } from "./marshal.ts";

export {
  SqliteBusyError,
  SqliteCantOpenError,
  SqliteConstraintError,
  SqliteCorruptError,
  SqliteError,
  SqliteMisuseError,
  SqliteRangeError,
  SqliteReadonlyError,
} from "./errors.ts";
