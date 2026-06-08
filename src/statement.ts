import type { Sqlite3 } from "./glue.ts";
import type { DbPtr, StmtPtr } from "./wasm/ptr.ts";
import { SqliteMisuseError, toSqliteError } from "./errors.ts";
import { bindValue, narrowInt, readColumn, type SqlValue } from "./marshal.ts";

/** A statement's entry in its owning database's finalize registry (see `database.ts`). */
export interface StatementHandle {
  readonly finalize: () => void;
}

export type StatementRegistry = Set<StatementHandle>;

/** The outcome of a mutating statement run for its row count and inserted id. */
export interface RunResult {
  /** Rows inserted, updated, or deleted by the most recent execution. */
  readonly changes: number;
  /** `rowid` of the last inserted row — `bigint` past 2^53, else `number`. */
  readonly lastInsertRowid: number | bigint;
}

/**
 * A compiled, reusable statement yielding rows of `Row`. Each call binds the
 * given positional parameters (1-based `?`), runs, and resets the statement for
 * the next call. The owning database finalizes it on close; finalize it sooner
 * with `using` or `[Symbol.dispose]`. Calling any method after finalize throws
 * `SqliteMisuseError`.
 */
export interface Statement<Row> {
  /**
   * Runs the statement and returns the first row, or `undefined` if none.
   * Executes the statement — a mutating statement run through `get` still writes.
   */
  readonly get: (...params: readonly SqlValue[]) => Row | undefined;
  /**
   * Runs the statement and collects every row. Executes the statement — a
   * mutating statement run through `all` still writes.
   */
  readonly all: (...params: readonly SqlValue[]) => Row[];
  /**
   * Runs the statement and yields rows lazily. The statement is reset when the
   * iterator is exhausted, broken out of (`break`/`return`), or disposed — so an
   * early exit never leaves the statement mid-scan. Executes the statement — a
   * mutating statement run through `iter` still writes.
   */
  readonly iter: (...params: readonly SqlValue[]) => IterableIterator<Row>;
  /** Runs a mutating statement, returning its change count and last insert id. */
  readonly run: (...params: readonly SqlValue[]) => RunResult;
  /**
   * Runs the statement and exposes its rows as a backpressured `ReadableStream`:
   * each pull steps the cursor once, so a slow consumer never overruns memory.
   * Cancelling or fully draining resets the statement for reuse. Only one stream
   * or run can be live on a statement at a time — a second resets the first.
   * Executes the statement — a mutating statement run through `stream` still writes.
   */
  readonly stream: (...params: readonly SqlValue[]) => ReadableStream<Row>;
  readonly [Symbol.dispose]: () => void;
}

const prepare = (sqlite3: Sqlite3, db: DbPtr, sql: string): StmtPtr => {
  const { capi, wasm } = sqlite3;
  const stack = wasm.pstack.pointer;
  try {
    const ppStmt = wasm.pstack.alloc(4);
    const rc = capi.sqlite3_prepare_v3(db, sql, -1, 0, ppStmt, null);
    if (rc !== capi.SQLITE_OK) throw toSqliteError(rc, sqlite3, db);
    // The out-pointer holds an `sqlite3_stmt*`; one boundary reinterpret of the
    // ABI i32 into the branded handle.
    const ptr = wasm.peekPtr(ppStmt) as StmtPtr;
    // Empty or comment-only SQL prepares to OK with a null handle; wrapping it
    // would crash on the first `step`/`column_*`, so reject it as misuse.
    if (ptr === 0) {
      throw new SqliteMisuseError(
        "no statement to prepare (empty or comment-only SQL)",
        capi.SQLITE_MISUSE,
        capi.SQLITE_MISUSE,
      );
    }
    return ptr;
  } finally {
    wasm.pstack.restore(stack);
  }
};

export const createStatement = <Row>(
  sqlite3: Sqlite3,
  db: DbPtr,
  sql: string,
  registry: StatementRegistry,
): Statement<Row> => {
  const { capi } = sqlite3;
  const stmt = prepare(sqlite3, db, sql);
  let finalized = false;
  let names: readonly string[] | undefined;
  let generation = 0;

  const ensureLive = (): void => {
    if (finalized) {
      throw new SqliteMisuseError("statement is finalized", capi.SQLITE_MISUSE, capi.SQLITE_MISUSE);
    }
  };

  const columnNames = (): readonly string[] => {
    if (names !== undefined) return names;
    const n = capi.sqlite3_column_count(stmt);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(capi.sqlite3_column_name(stmt, i));
    names = out;
    return out;
  };

  const readRow = (): Row => {
    const cols = columnNames();
    // Null-prototype so a column named `__proto__` (or `constructor`) is a plain
    // own data property — not the `Object.prototype` setter that would silently
    // drop the value — and no prototype is reachable to pollute.
    const row: Record<string, SqlValue> = Object.create(null);
    for (let i = 0; i < cols.length; i++) {
      const key = cols[i];
      if (key === undefined) continue;
      row[key] = readColumn(sqlite3, stmt, i);
    }
    // The caller declares `Row` as its claim about the column shape; building a
    // `Record<string, SqlValue>` and asserting it is the single Row coercion.
    return row as Row;
  };

  const bindAll = (params: readonly SqlValue[]): void => {
    for (let i = 0; i < params.length; i++) {
      const rc = bindValue(sqlite3, stmt, i + 1, params[i]);
      if (rc !== capi.SQLITE_OK) throw toSqliteError(rc, sqlite3, db);
    }
  };

  const reset = (): void => {
    capi.sqlite3_reset(stmt);
    capi.sqlite3_clear_bindings(stmt);
  };

  const start = (params: readonly SqlValue[]): void => {
    ensureLive();
    generation++;
    reset();
    bindAll(params);
  };

  const step = (): boolean => {
    const rc = capi.sqlite3_step(stmt);
    if (rc === capi.SQLITE_ROW) return true;
    if (rc === capi.SQLITE_DONE) return false;
    throw toSqliteError(rc, sqlite3, db);
  };

  const get = (...params: readonly SqlValue[]): Row | undefined => {
    start(params);
    try {
      return step() ? readRow() : undefined;
    } finally {
      reset();
    }
  };

  const all = (...params: readonly SqlValue[]): Row[] => {
    start(params);
    const rows: Row[] = [];
    try {
      while (step()) rows.push(readRow());
      return rows;
    } finally {
      reset();
    }
  };

  const iter = function* (...params: readonly SqlValue[]): IterableIterator<Row> {
    start(params);
    try {
      while (step()) yield readRow();
    } finally {
      reset();
    }
  };

  const run = (...params: readonly SqlValue[]): RunResult => {
    start(params);
    try {
      while (step());
      // `sqlite3_changes`/`last_insert_rowid` are connection-global: correct only
      // because they are read synchronously here, right after step-DONE and before
      // any other statement on this db runs. Do not defer this read.
      return {
        changes: capi.sqlite3_changes(db),
        lastInsertRowid: narrowInt(capi.sqlite3_last_insert_rowid(db)),
      };
    } finally {
      reset();
    }
  };

  const stream = (...params: readonly SqlValue[]): ReadableStream<Row> => {
    // `start(params)` runs in the first `pull`, not the stream's own `start`: a
    // throw there (use-after-finalize, a bind failure) escapes the constructor
    // synchronously, but inside `pull` it surfaces to the consumer as a stream
    // error. One `step()` per pull is the backpressure — never drain ahead.
    let started = false;
    let gen = 0;
    // Reset only if this stream still owns the cursor: a later `all`/`get`/stream
    // bumps `generation`, so a stale stream's error/cancel cleanup would otherwise
    // reset the new run's bindings (`start` captures the generation it began).
    const ownsCursor = (): boolean => !finalized && started && gen === generation;
    return new ReadableStream<Row>({
      pull: (controller) => {
        try {
          if (!started) {
            start(params);
            gen = generation;
            started = true;
          }
          if (step()) controller.enqueue(readRow());
          else {
            reset();
            controller.close();
          }
        } catch (err) {
          if (ownsCursor()) reset();
          controller.error(err);
        }
      },
      cancel: () => {
        // Resetting a finalized handle is use-after-free across the wasm boundary
        // (`wasm.md`); resetting after another run took over corrupts that run.
        if (ownsCursor()) reset();
      },
    });
  };

  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    registry.delete(handle);
    capi.sqlite3_finalize(stmt);
  };

  const handle: StatementHandle = { finalize };
  registry.add(handle);

  return { get, all, iter, run, stream, [Symbol.dispose]: finalize };
};
