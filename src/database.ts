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
// `SQLITE_MISUSE`, inlined because the option guard rejects before the engine
// loads, so `capi.SQLITE_MISUSE` is not yet reachable.
const SQLITE_MISUSE = 21;
const SQLITE_CANTOPEN = 14;

/**
 * How the engine commits, in terms of the modes proven corruption-free by the
 * crash and concurrency harnesses (Phases 4-6). Each mode bundles the exact
 * pragma envelope its proof rests on; the union shape makes the unproven
 * combinations — notably multi-process + WAL — unrepresentable.
 *
 * `durability` controls **commit durability**, which is separate from integrity.
 * Either level keeps the database **corruption-free** across modeled power loss
 * (`PRAGMA integrity_check` stays `ok`); they differ only in whether the *latest*
 * committed transaction survives a crash:
 * - `"full"`: a committed transaction survives modeled power loss.
 * - `"normal"`: consistency-safe, but the **latest committed transaction may be
 *   lost** on power loss. Faster — one fewer fsync per commit.
 *
 * - `rollback` (default): rollback journal (`journal_mode=PERSIST`) over the
 *   X-strict whole-file lock ladder (DEC-009). Multi-process **serialized** — one
 *   accessor at a time. Defaults to `durability: "full"` (durable-by-default):
 *   `"normal"` here can drop the last commit when a torn next-transaction journal
 *   is resurrected on reopen, and `"full"` adds the journal-header sync that
 *   closes that window (DEC-008, BUG-004).
 * - `wal`: write-ahead log under `locking_mode=EXCLUSIVE`, so the wal-index lives
 *   in heap with no `-shm` (DEC-010). **Single process.** Defaults to
 *   `durability: "normal"` — the SQLite-recommended WAL default; pass
 *   `durability: "full"` to also make the last commit power-loss-durable (ENH-003).
 */
export type OpenMode =
  | { readonly mode?: "rollback"; readonly durability?: "normal" | "full" }
  | { readonly mode: "wal"; readonly durability?: "normal" | "full" };

export type OpenOptions = OpenMode & {
  /** Open read-only; never create. A write then fails with `SqliteReadonlyError`. */
  readonly readonly?: boolean;
};

/**
 * A live database connection over the Deno-filesystem VFS. The connection owns
 * every statement it prepares: disposing the database finalizes any that are
 * still open, exactly once. Dispose it (`using`, or an explicit
 * `db[Symbol.dispose]()`) or the file handle and the WAL checkpoint leak.
 */
export interface Database {
  /**
   * Runs one or more semicolon-separated statements for their effect, returning
   * no rows. Use for DDL and pragmas; use `prepare` when you need results or
   * bound parameters.
   */
  readonly exec: (sql: string) => void;
  /**
   * Compiles `sql` into a reusable typed statement. `Row` is the shape `all`,
   * `get`, and `iter` yield — the caller annotates only that; positions bind via
   * the statement's call signature. The statement is owned by this database.
   */
  readonly prepare: <Row = Record<string, SqlValue>>(sql: string) => Statement<Row>;
  /**
   * Opens a savepoint-backed transaction over this connection. Nest freely:
   * inner transactions commit or roll back independently of the outer. A
   * `using tx` that throws before `commit` rolls back. Disposing the database
   * with a transaction still open discards it implicitly — the close drops the
   * savepoint — so finish transactions before the database, not after.
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
    // The out-pointer holds an `sqlite3_stmt*`; one boundary reinterpret of the
    // i32 the ABI returns into the branded handle.
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

/**
 * Re-checks the db path against Deno's grant before the engine opens it, so a
 * symlink-escape or a missing parent-directory read grant surfaces as a clear,
 * `instanceof`-discriminable `SqliteCantOpenError` instead of an opaque downstream
 * IOERR. The VFS enforces the same check on every file it opens (the journal and
 * wal are opened lazily); this pre-flight only sharpens the message for the main
 * db path, naming the parent-directory grant the canonicalization (and DEC-008's
 * directory fsync) needs (SEC-001, ENH-002).
 */
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
    // The out-pointer holds an `sqlite3*`; reinterpret the ABI i32 into the
    // branded handle once. SQLite allocates the handle even on failure so it can
    // carry a diagnostic, so the close must run on the error path too.
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

const rejectReadonlyWal = (opts: OpenOptions): void => {
  if (opts.readonly === true && opts.mode === "wal") {
    // A read-only connection cannot run `journal_mode=WAL`, so honoring the
    // explicit WAL request is impossible; reject rather than silently drop it.
    throw new SqliteMisuseError(
      "readonly and mode 'wal' are incompatible: a read-only connection cannot establish WAL",
      SQLITE_MISUSE,
      SQLITE_MISUSE,
    );
  }
};

/**
 * The shared open envelope, parameterized only by which VFS the handle binds to.
 * It runs the full proven configuration (`OpenMode` → rollback/WAL pragma
 * sequence, the readonly+wal guard) against an already-loaded engine whose
 * `vfsName` is already registered — never installing or selecting a VFS itself.
 *
 * Not exported from `mod.ts`: this is the internal seam the crash/concurrency
 * harnesses import to point the proven envelope at the deterministic crash-sim
 * VFS, so the L3/L4 proofs exercise the shipped `Database`/`Statement`/
 * `Transaction` surface rather than the engine alone. Exposing VFS selection on
 * the public API would let a caller escape the proven-mode envelope (security
 * review, DBT-005); production `openDatabase` therefore hard-binds the
 * Deno-filesystem VFS and never threads a name through.
 */
export const openDatabaseWithVfs = (
  sqlite3: Sqlite3,
  path: string,
  vfsName: string,
  opts: OpenOptions = {},
): Database => {
  rejectReadonlyWal(opts);
  const handle = openHandle(sqlite3, path, vfsName, opts);
  try {
    configure({ sqlite3, handle }, opts);
  } catch (e) {
    sqlite3.capi.sqlite3_close_v2(handle);
    throw e;
  }
  return createDatabase(sqlite3, handle);
};

/**
 * Opens the database file at `path` over the Deno-filesystem VFS and configures
 * the proven commit mode (`rollback` by default, `wal` opt-in). The only
 * capability required is read — and, for durable writes, write — access to that
 * path; the wasm has no ambient authority (`security.md`). Dispose the returned
 * `Database` (`using`) or the file handle leaks.
 */
export const openDatabase = async (
  path: string,
  opts: OpenOptions = {},
): Promise<Database> => {
  rejectReadonlyWal(opts);
  const sqlite3 = await loadSqlite3();
  installDenoVfs(sqlite3);
  preflightGrant(sqlite3, path, opts);
  return openDatabaseWithVfs(sqlite3, path, DENO_VFS_NAME, opts);
};
