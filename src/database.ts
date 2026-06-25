import type { Sqlite3 } from "./glue.ts";
import type { DbPtr, StmtPtr } from "./wasm/ptr.ts";
import { loadSqlite3 } from "./glue.ts";
import { DENO_VFS_NAME, installDenoVfs } from "./vfs/deno.ts";
import { SqliteCantOpenError, SqliteMisuseError, toSqliteError } from "./errors.ts";
import type { SqlValue } from "./marshal.ts";
import { guardOpen } from "./vfs/guard.ts";
import { createStatement, type Statement, type StatementRegistry } from "./statement.ts";
import { createTransactionFactory, type Transaction } from "./transaction.ts";

const SQLITE_OPEN_READONLY = 0x0000_0001;
const SQLITE_OPEN_READWRITE = 0x0000_0002;
const SQLITE_OPEN_CREATE = 0x0000_0004;
const SQLITE_OPEN_EXRESCODE = 0x0200_0000;
// Inlined: the option guard rejects before the engine loads `capi.SQLITE_MISUSE`.
const SQLITE_MISUSE = 21;
const SQLITE_CANTOPEN = 14;

/**
 * Commit mode + durability, each bundling the pragma envelope its crash-proof rests on.
 * `durability` is commit survival, not integrity (both stay corruption-free); see tech-stack.md.
 */
export type OpenMode =
  | { readonly mode?: "rollback"; readonly durability?: "normal" | "full" }
  | { readonly mode: "wal"; readonly durability?: "normal" | "full" };

export type OpenOptions = OpenMode & {
  /** Open read-only; never create. A write then fails with `SqliteReadonlyError`. */
  readonly readonly?: boolean;
  /**
   * Block-and-retry milliseconds on a contended lock before `SqliteBusyError`; default 0 (immediate).
   * Not a guarantee — a contended serialized workload can still exhaust it; keep your own retry loop.
   */
  readonly busyTimeout?: number;
  /** Cancels a slow open; checked between await stages. No effect once the `Database` resolves. */
  readonly signal?: AbortSignal;
};

/**
 * A live connection over the Deno-filesystem VFS; owns every statement it prepares.
 * Dispose it (`using`) or the file handle and the WAL checkpoint leak.
 */
export interface Database {
  /** Runs semicolon-separated statements for effect, no rows. Use `prepare` for results or params. */
  readonly exec: (sql: string) => void;
  /** Compiles `sql` into a reusable typed statement owned by this db; `Row` is the row shape. */
  readonly prepare: <Row = Record<string, SqlValue>>(sql: string) => Statement<Row>;
  /**
   * Opens a savepoint-backed transaction; nests freely. A `using tx` that throws rolls back.
   * Disposing the db discards an open transaction — finish transactions before the db.
   */
  readonly transaction: () => Transaction;
  readonly [Symbol.dispose]: () => void;
}

const pragmaSync = (durability: "normal" | "full"): string =>
  durability === "full" ? "PRAGMA synchronous=FULL" : "PRAGMA synchronous=NORMAL";

interface RawDb {
  readonly sqlite3: Sqlite3;
  readonly handle: DbPtr;
}

const execRaw = ({ sqlite3, handle }: RawDb, sql: string): void => {
  const rc = sqlite3.capi.sqlite3_exec(handle, sql, 0, 0, 0);
  if (rc !== sqlite3.capi.SQLITE_OK) throw toSqliteError(rc, sqlite3, handle);
};

const selectText = ({ sqlite3, handle }: RawDb, sql: string): string | undefined => {
  const { capi, wasm } = sqlite3;
  const stack = wasm.pstack.pointer;
  try {
    const ppStmt = wasm.pstack.alloc(4);
    // Boundary reinterpret: the ABI i32 out-pointer is an `sqlite3_stmt*` (wasm.md).
    const prepRc = capi.sqlite3_prepare_v3(handle, sql, -1, 0, ppStmt, null);
    if (prepRc !== capi.SQLITE_OK) throw toSqliteError(prepRc, sqlite3, handle);
    const stmt = wasm.peekPtr(ppStmt) as StmtPtr;
    try {
      const stepRc = capi.sqlite3_step(stmt);
      if (stepRc === capi.SQLITE_ROW) return capi.sqlite3_column_text(stmt, 0);
      if (stepRc === capi.SQLITE_DONE) return undefined;
      throw toSqliteError(stepRc, sqlite3, handle);
    } finally {
      capi.sqlite3_finalize(stmt);
    }
  } finally {
    wasm.pstack.restore(stack);
  }
};

const enterWal = (raw: RawDb, durability: "normal" | "full"): void => {
  execRaw(raw, "PRAGMA locking_mode=EXCLUSIVE");
  const journal = selectText(raw, "PRAGMA journal_mode=WAL");
  if (journal !== "wal") {
    throw new Error(
      `WAL mode did not engage (journal_mode=${journal ?? "unknown"}); ` +
        "the connection refused write-ahead logging",
    );
  }
  execRaw(raw, pragmaSync(durability));
};

const enterRollback = (raw: RawDb, durability: "normal" | "full"): void => {
  execRaw(raw, "PRAGMA journal_mode=PERSIST");
  execRaw(raw, pragmaSync(durability));
};

const configure = (raw: RawDb, opts: OpenOptions): void => {
  if (opts.readonly === true) return;
  if (opts.mode === "wal") {
    enterWal(raw, opts.durability ?? "normal");
    return;
  }
  enterRollback(raw, opts.durability ?? "full");
};

const openFlags = (opts: OpenOptions): number =>
  opts.readonly === true
    ? SQLITE_OPEN_READONLY | SQLITE_OPEN_EXRESCODE
    : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_EXRESCODE;

// Pre-flight so a symlink-escape / missing parent-read grant surfaces as a clear
// SqliteCantOpenError, not an opaque downstream IOERR (SEC-001, ENH-002).
const preflightGrant = (sqlite3: Sqlite3, path: string, opts: OpenOptions): void => {
  const result = guardOpen(sqlite3, path, openFlags(opts));
  if (result.kind === "granted") return;
  const message = result.kind === "parent-unreadable"
    ? "cannot open database: its parent directory is not in the read grant — " +
      "grant --allow-read (and --allow-write for durable writes) on the parent " +
      "directory, not the file alone"
    : "cannot open database: the path resolves through a symlink to a target " +
      "outside the granted directory; refusing to open outside the grant";
  throw new SqliteCantOpenError(message, SQLITE_CANTOPEN, SQLITE_CANTOPEN);
};

const openHandle = (
  sqlite3: Sqlite3,
  path: string,
  vfsName: string,
  opts: OpenOptions,
): DbPtr => {
  const { capi, wasm } = sqlite3;
  const flags = openFlags(opts);
  const stack = wasm.pstack.pointer;
  try {
    const ppDb = wasm.pstack.alloc(4);
    const rc = capi.sqlite3_open_v2(path, ppDb, flags, vfsName);
    // Boundary reinterpret of the ABI i32 into `sqlite3*`. SQLite allocates the handle even on
    // failure (to carry a diagnostic), so close must run on the error path too.
    const handle = wasm.peekPtr(ppDb) as DbPtr;
    if (rc !== capi.SQLITE_OK) {
      const err = toSqliteError(rc, sqlite3, handle);
      capi.sqlite3_close_v2(handle);
      throw err;
    }
    return handle;
  } finally {
    wasm.pstack.restore(stack);
  }
};

const createDatabase = (sqlite3: Sqlite3, handle: DbPtr): Database => {
  const raw: RawDb = { sqlite3, handle };
  const open: StatementRegistry = new Set();
  const transaction = createTransactionFactory(
    (sql) => execRaw(raw, sql),
    sqlite3.capi.SQLITE_MISUSE,
  );
  let closed = false;

  const db: Database = {
    exec: (sql) => execRaw(raw, sql),
    prepare: <Row>(sql: string) => createStatement<Row>(sqlite3, handle, sql, open),
    transaction,
    [Symbol.dispose]: () => {
      if (closed) return;
      closed = true;
      for (const stmt of open) stmt.finalize();
      open.clear();
      sqlite3.capi.sqlite3_close_v2(handle);
    },
  };
  return db;
};

const validateBusyTimeout = (opts: OpenOptions): void => {
  const { busyTimeout } = opts;
  if (busyTimeout === undefined) return;
  if (!Number.isInteger(busyTimeout) || busyTimeout < 0) {
    throw new SqliteMisuseError(
      `busyTimeout must be a non-negative integer of milliseconds; got ${busyTimeout}`,
      SQLITE_MISUSE,
      SQLITE_MISUSE,
    );
  }
};

const applyBusyTimeout = (raw: RawDb, opts: OpenOptions): void => {
  const ms = opts.busyTimeout ?? 0;
  if (ms === 0) return;
  const { sqlite3, handle } = raw;
  const rc = sqlite3.capi.sqlite3_busy_timeout(handle, ms);
  if (rc !== sqlite3.capi.SQLITE_OK) throw toSqliteError(rc, sqlite3, handle);
};

const rejectReadonlyWal = (opts: OpenOptions): void => {
  if (opts.readonly === true && opts.mode === "wal") {
    // A readonly connection can't run journal_mode=WAL — reject, don't silently drop the request.
    throw new SqliteMisuseError(
      "readonly and mode 'wal' are incompatible: a read-only connection cannot establish WAL",
      SQLITE_MISUSE,
      SQLITE_MISUSE,
    );
  }
};

/**
 * Internal harness seam: the proven open envelope over a named, pre-registered VFS. Not exported
 * from mod.ts — exposing VFS choice would let a caller escape the proven-mode envelope (DBT-005).
 */
export const openDatabaseWithVfs = (
  sqlite3: Sqlite3,
  path: string,
  vfsName: string,
  opts: OpenOptions = {},
): Database => {
  rejectReadonlyWal(opts);
  validateBusyTimeout(opts);
  const handle = openHandle(sqlite3, path, vfsName, opts);
  const raw: RawDb = { sqlite3, handle };
  try {
    applyBusyTimeout(raw, opts);
    configure(raw, opts);
  } catch (e) {
    sqlite3.capi.sqlite3_close_v2(handle);
    throw e;
  }
  return createDatabase(sqlite3, handle);
};

/**
 * Opens the db at `path` over the Deno-filesystem VFS in the proven commit mode (rollback default,
 * wal opt-in). Needs only read — and write for durable writes — on `path`. Dispose (`using`) or it leaks.
 */
export const openDatabase = async (
  path: string,
  opts: OpenOptions = {},
): Promise<Database> => {
  const { signal } = opts;
  signal?.throwIfAborted();
  rejectReadonlyWal(opts);
  validateBusyTimeout(opts);
  const sqlite3 = await loadSqlite3();
  signal?.throwIfAborted();
  installDenoVfs(sqlite3);
  preflightGrant(sqlite3, path, opts);
  signal?.throwIfAborted();
  return openDatabaseWithVfs(sqlite3, path, DENO_VFS_NAME, opts);
};
