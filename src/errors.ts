import type { Sqlite3 } from "./glue.ts";
import type { DbPtr } from "./wasm/ptr.ts";

type Category =
  | "busy"
  | "constraint"
  | "cantOpen"
  | "readonly"
  | "corrupt"
  | "range"
  | "misuse"
  | "other";

const primaryOf = (rc: number): number => rc & 0xff;

/** Thrown for every SQLite failure; carries SQLite's diagnostic, never the caller's path/data (security.md). */
export class SqliteError extends Error {
  override readonly name: string = "SqliteError";
  readonly code: number;
  readonly extendedCode: number;

  constructor(message: string, code: number, extendedCode: number) {
    super(message);
    // Restores the prototype link the transpile target severs so `instanceof` holds for subclasses.
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
    this.extendedCode = extendedCode;
  }
}

/** A lock could not be acquired (`SQLITE_BUSY` / `SQLITE_LOCKED`) — retryable. */
export class SqliteBusyError extends SqliteError {
  override readonly name = "SqliteBusyError";
}

/** A constraint failed (`SQLITE_CONSTRAINT`); `extendedCode` names which kind. */
export class SqliteConstraintError extends SqliteError {
  override readonly name = "SqliteConstraintError";
}

/** The database file could not be opened (`SQLITE_CANTOPEN`) — often a grant gap. */
export class SqliteCantOpenError extends SqliteError {
  override readonly name = "SqliteCantOpenError";
}

/** A write was attempted on a read-only database (`SQLITE_READONLY`). */
export class SqliteReadonlyError extends SqliteError {
  override readonly name = "SqliteReadonlyError";
}

/** The file is malformed or not a database (`SQLITE_CORRUPT` / `SQLITE_NOTADB`). */
export class SqliteCorruptError extends SqliteError {
  override readonly name = "SqliteCorruptError";
}

/** A bind or column index was out of range (`SQLITE_RANGE`) — a caller bug. */
export class SqliteRangeError extends SqliteError {
  override readonly name = "SqliteRangeError";
}

/** The library was used incorrectly (`SQLITE_MISUSE`) — a caller bug. */
export class SqliteMisuseError extends SqliteError {
  override readonly name = "SqliteMisuseError";
}

const categoryByPrimary: ReadonlyMap<number, Category> = new Map<number, Category>([
  [5, "busy"], // SQLITE_BUSY
  [6, "busy"], // SQLITE_LOCKED
  [19, "constraint"], // SQLITE_CONSTRAINT
  [14, "cantOpen"], // SQLITE_CANTOPEN
  [8, "readonly"], // SQLITE_READONLY
  [11, "corrupt"], // SQLITE_CORRUPT
  [26, "corrupt"], // SQLITE_NOTADB
  [25, "range"], // SQLITE_RANGE
  [21, "misuse"], // SQLITE_MISUSE
]);

const construct = (
  category: Category,
  message: string,
  code: number,
  extendedCode: number,
): SqliteError => {
  switch (category) {
    case "busy":
      return new SqliteBusyError(message, code, extendedCode);
    case "constraint":
      return new SqliteConstraintError(message, code, extendedCode);
    case "cantOpen":
      return new SqliteCantOpenError(message, code, extendedCode);
    case "readonly":
      return new SqliteReadonlyError(message, code, extendedCode);
    case "corrupt":
      return new SqliteCorruptError(message, code, extendedCode);
    case "range":
      return new SqliteRangeError(message, code, extendedCode);
    case "misuse":
      return new SqliteMisuseError(message, code, extendedCode);
    case "other":
      return new SqliteError(message, code, extendedCode);
    default:
      return assertNever(category);
  }
};

const assertNever = (x: never): never => {
  throw new Error(`unreachable category: ${String(x)}`);
};

/** Maps a result code to its typed error; pass `db` for a precise `errmsg`, else SQLite's static `errstr`. */
export const toSqliteError = (
  rc: number,
  sqlite3: Sqlite3,
  db?: DbPtr,
): SqliteError => {
  const { capi } = sqlite3;
  const extendedCode = db === undefined ? rc : capi.sqlite3_extended_errcode(db);
  const code = primaryOf(extendedCode);
  const message = db === undefined ? capi.sqlite3_errstr(code) : capi.sqlite3_errmsg(db);
  const category = categoryByPrimary.get(code) ?? "other";
  return construct(category, message, code, extendedCode);
};
