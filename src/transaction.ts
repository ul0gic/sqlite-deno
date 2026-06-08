import { SqliteMisuseError } from "./errors.ts";

/**
 * A scoped unit of work over the owning database's connection, implemented as a
 * SQLite SAVEPOINT so it nests cleanly: a top-level transaction behaves like a
 * normal one, and an inner transaction commits or rolls back independently of
 * the outer. Disposing without an explicit `commit`/`rollback` rolls back — a
 * thrown body inside `using tx` never silently commits. After it finishes
 * (commit, rollback, or dispose-rollback), `commit`/`rollback` throw
 * `SqliteMisuseError`.
 */
export interface Transaction {
  /** Releases the savepoint, making this unit of work durable within its parent. */
  readonly commit: () => void;
  /** Rolls back to the savepoint, discarding every change made since it opened. */
  readonly rollback: () => void;
  readonly [Symbol.dispose]: () => void;
}

/** Runs SQL on the database connection the transaction shares. */
export type RunSql = (sql: string) => void;

/**
 * Mints transactions over `runSql`, naming each SAVEPOINT from a monotonic
 * per-database counter so names are ours alone — never caller input — and
 * nesting composes (`security.md`). `misuse` is `SQLITE_MISUSE`, carried so the
 * lifecycle errors match the engine's code without a magic literal. The
 * connection close discards any savepoint left open, so an undisposed
 * transaction at db-close is harmless, not a leak.
 */
export const createTransactionFactory = (
  runSql: RunSql,
  misuse: number,
): () => Transaction => {
  let counter = 0;

  return (): Transaction => {
    const name = `sp_${++counter}`;
    let finished = false;

    const rollbackSql = (): void => runSql(`ROLLBACK TO ${name}; RELEASE ${name}`);

    const finish = (run: () => void): void => {
      if (finished) {
        throw new SqliteMisuseError("transaction already finished", misuse, misuse);
      }
      // Latch only after `run()` succeeds: a throw here (a transient BUSY/IO on
      // RELEASE) leaves the savepoint open, so the tx must stay unfinished for
      // `[Symbol.dispose]`/retry to still tear it down.
      run();
      finished = true;
    };

    runSql(`SAVEPOINT ${name}`);

    return {
      commit: () => finish(() => runSql(`RELEASE ${name}`)),
      rollback: () => finish(rollbackSql),
      [Symbol.dispose]: () => {
        if (finished) return;
        finished = true;
        rollbackSql();
      },
    };
  };
};
