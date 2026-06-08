import { openDatabase } from "../../src/database.ts";
import type { Database, OpenOptions } from "../../src/database.ts";
import { SqliteError } from "../../src/errors.ts";
import type { FuzzMode, FuzzSeed } from "./model.ts";
import { asSeed } from "./model.ts";
import { generateSequence } from "./generator.ts";
import { execOp, settleStreams } from "./execute.ts";
import { OracleViolation } from "./oracle.ts";

const openOptionsFor = (mode: FuzzMode): OpenOptions =>
  mode === "wal" ? { mode: "wal" } : { mode: "rollback" };

const integrityOk = (db: Database, seed: number): void => {
  using stmt = db.prepare<{ integrity_check: string }>("PRAGMA integrity_check");
  const verdict = stmt.get()?.integrity_check;
  if (verdict !== "ok") {
    throw new OracleViolation("integrity", seed, `integrity_check = ${JSON.stringify(verdict)}`);
  }
};

const stillUsable = (db: Database, seed: number): void => {
  try {
    using stmt = db.prepare<{ n: number }>("SELECT 1 AS n");
    const row = stmt.get();
    if (row?.n !== 1) {
      throw new OracleViolation("usable", seed, `follow-up query returned ${JSON.stringify(row)}`);
    }
  } catch (e) {
    if (e instanceof OracleViolation) throw e;
    if (e instanceof SqliteError) {
      throw new OracleViolation("usable", seed, `follow-up query threw ${e.name}: ${e.message}`);
    }
    throw new OracleViolation(
      "usable",
      seed,
      `follow-up query threw non-SqliteError: ${String(e)}`,
    );
  }
};

export interface SequenceResult {
  readonly seed: number;
  readonly mode: FuzzMode;
  readonly ops: number;
}

/**
 * Runs one generated sequence end-to-end against a freshly opened real database,
 * then checks every oracle property. The DB is disposed in `finally`; a throw
 * from dispose itself is the "dispose" property failing.
 */
export const runSequence = async (
  dir: string,
  seed: FuzzSeed,
  mode: FuzzMode,
  length: number,
  explicitPath?: string,
): Promise<SequenceResult> => {
  const path = explicitPath ?? `${dir}/fuzz-${(seed >>> 0).toString(16)}-${mode}.db`;
  const ops = generateSequence(seed, length);
  const db = await openDatabase(path, openOptionsFor(mode));
  let bodyError: unknown;
  try {
    for (const op of ops) execOp(db, op, seed);
    await settleStreams();
    integrityOk(db, seed);
    stillUsable(db, seed);
  } catch (e) {
    bodyError = e;
  }
  try {
    db[Symbol.dispose]();
  } catch (e) {
    throw new OracleViolation("dispose", seed, `db dispose threw: ${String(e)}`);
  }
  if (bodyError !== undefined) throw bodyError;
  return { seed, mode, ops: ops.length };
};

export const runSeedAcrossModes = async (
  dir: string,
  rawSeed: number,
  length: number,
): Promise<readonly SequenceResult[]> => {
  const seed = asSeed(rawSeed);
  const rollback = await runSequence(dir, seed, "rollback", length);
  const wal = await runSequence(dir, seed, "wal", length);
  return [rollback, wal];
};
