import type { Database } from "../../src/database.ts";
import { SqliteError } from "../../src/errors.ts";
import type { FuzzOp, QueryOp, TxnOp } from "./model.ts";
import { opLabel } from "./model.ts";
import { OracleViolation } from "./oracle.ts";

class FuzzRollback extends Error {
  override readonly name = "FuzzRollback";
}

const pendingStreams: Promise<void>[] = [];

export const settleStreams = async (): Promise<void> => {
  const inflight = pendingStreams.splice(0, pendingStreams.length);
  await Promise.allSettled(inflight);
};

const drainStream = (db: Database, op: QueryOp, seed: number): void => {
  const reader = db.prepare(op.sql).stream(...op.params).getReader();
  pendingStreams.push((async () => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    } catch (e) {
      if (e instanceof SqliteError) return;
      throw new OracleViolation(
        "no-abort",
        seed,
        `stream "${opLabel(op)}" surfaced a non-SqliteError — ${String(e)}`,
      );
    }
  })());
};

const runQuery = (db: Database, op: QueryOp, seed: number): void => {
  if (op.method === "stream") {
    drainStream(db, op, seed);
    return;
  }
  using stmt = db.prepare(op.sql);
  if (op.method === "all") stmt.all(...op.params);
  else if (op.method === "get") stmt.get(...op.params);
  else for (const _ of stmt.iter(...op.params)) { /* drain */ }
};

const runLeaf = (db: Database, op: Exclude<FuzzOp, TxnOp>, seed: number): void => {
  switch (op.kind) {
    case "exec":
      db.exec(op.sql);
      return;
    case "query":
      runQuery(db, op, seed);
      return;
    case "run": {
      using stmt = db.prepare(op.sql);
      stmt.run(...op.params);
      return;
    }
    default:
      throw new Error(`unreachable leaf kind: ${JSON.stringify(op)}`);
  }
};

const runTxn = (db: Database, op: TxnOp, seed: number): void => {
  const tx = db.transaction();
  try {
    for (const child of op.body) execOp(db, child, seed);
    if (op.outcome === "commit") tx.commit();
    else if (op.outcome === "rollback") tx.rollback();
    else if (op.outcome === "throw") throw new FuzzRollback("generated rollback-via-throw");
  } finally {
    tx[Symbol.dispose]();
  }
};

/**
 * Runs one fuzzed operation, enforcing the no-abort property: the only failures
 * allowed to surface are `SqliteError` (the typed contract), the synthetic
 * `FuzzRollback` (a generated `using`-rollback), and `OracleViolation` (a real
 * property failure, which propagates untouched). Anything else is a native abort
 * leaking across the WASM/C boundary — re-thrown as a seeded `OracleViolation`.
 */
export const execOp = (db: Database, op: FuzzOp, seed: number): void => {
  try {
    if (op.kind === "txn") runTxn(db, op, seed);
    else runLeaf(db, op, seed);
  } catch (e) {
    if (e instanceof FuzzRollback) return;
    if (e instanceof SqliteError) return;
    if (e instanceof OracleViolation) throw e;
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : `${typeof e} ${String(e)}`;
    throw new OracleViolation(
      "no-abort",
      seed,
      `op "${opLabel(op)}" threw a non-SqliteError — ${detail}`,
    );
  }
};
