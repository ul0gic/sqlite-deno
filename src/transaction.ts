import { SqliteMisuseError } from "./errors.ts";

/**
 * A nestable unit of work backed by a SAVEPOINT. Disposing without commit/rollback
 * rolls back; after it finishes, commit/rollback throw `SqliteMisuseError`.
 */
export interface Transaction {
  readonly commit: () => void;
  readonly rollback: () => void;
  readonly [Symbol.dispose]: () => void;
}

export type RunSql = (sql: string) => void;

/** SAVEPOINT names come from a per-db counter, never caller input (security.md). */
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
      // Latch only after run() succeeds: a throw leaves the savepoint open, so
      // the tx must stay unfinished for dispose/retry to tear it down.
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
