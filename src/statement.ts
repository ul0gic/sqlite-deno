import type { Sqlite3 } from "./glue.ts";
import type { DbPtr, StmtPtr } from "./wasm/ptr.ts";
import { SqliteMisuseError, toSqliteError } from "./errors.ts";
import { bindValue, narrowInt, readColumn, type SqlValue } from "./marshal.ts";

/** A statement's entry in its owning database's finalize registry (see `database.ts`). */
export interface StatementHandle {
  readonly finalize: () => void;
}

export type StatementRegistry = Set<StatementHandle>;

export interface RunResult {
  readonly changes: number;
  /** `rowid` of the last inserted row — `bigint` past 2^53, else `number`. */
  readonly lastInsertRowid: number | bigint;
}

/**
 * Compiled, reusable statement; each call re-binds and resets. The owning db
 * finalizes on close — sooner via `using`; any method after finalize throws.
 */
export interface Statement<Row> {
  /** Every run method executes even a mutating statement — `get`/`all`/`iter`/`stream` all write. */
  readonly get: (...params: readonly SqlValue[]) => Row | undefined;
  readonly all: (...params: readonly SqlValue[]) => Row[];
  /** Resets when exhausted, broken out of, or disposed — early exit never leaves a mid-scan cursor. */
  readonly iter: (...params: readonly SqlValue[]) => IterableIterator<Row>;
  readonly run: (...params: readonly SqlValue[]) => RunResult;
  /** Backpressured: one cursor step per pull. Only one stream/run live at a time — a second resets the first. */
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
    // Boundary reinterpret of the ABI i32 out-pointer into the branded `sqlite3_stmt*`.
    const ptr = wasm.peekPtr(ppStmt) as StmtPtr;
    // Empty/comment-only SQL prepares OK with a null handle; reject as misuse.
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
    // Null-prototype: a column named `__proto__`/`constructor` stays a plain data property, no pollution.
    const row: Record<string, SqlValue> = Object.create(null);
    for (let i = 0; i < cols.length; i++) {
      const key = cols[i];
      if (key === undefined) continue;
      row[key] = readColumn(sqlite3, stmt, i);
    }
    // `Row` is the caller's claim about column shape; this is the single Row coercion.
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
      // `changes`/`last_insert_rowid` are connection-global: read synchronously here,
      // before any other statement on this db runs. Do not defer.
      return {
        changes: capi.sqlite3_changes(db),
        lastInsertRowid: narrowInt(capi.sqlite3_last_insert_rowid(db)),
      };
    } finally {
      reset();
    }
  };

  const stream = (...params: readonly SqlValue[]): ReadableStream<Row> => {
    // `start` runs in the first `pull`, not the stream's `start`, so a throw surfaces
    // as a stream error to the consumer rather than synchronously from the constructor.
    let started = false;
    let gen = 0;
    // Reset only while this stream still owns the cursor: a later run bumps `generation`,
    // so stale cleanup would otherwise reset the new run's bindings.
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
        // Resetting a finalized handle is use-after-free across the wasm boundary (`wasm.md`).
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
