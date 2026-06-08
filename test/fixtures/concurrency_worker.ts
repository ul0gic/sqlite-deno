import { loadSqlite3 } from "../../src/glue.ts";
import { openDatabaseWithVfs } from "../../src/database.ts";
import { SqliteBusyError } from "../../src/errors.ts";
import type { Database } from "../../src/database.ts";
import {
  ACCOUNTS,
  assertBankInvariant,
  type BankSnapshot,
  installModeVfs,
  parseLockingMode,
  parseWorkerDriver,
  readBank,
  type WorkerResult,
} from "../harness/concurrency.ts";
import { createRng, type Rng } from "../harness/rng.ts";
import type { SqlValue } from "../../src/marshal.ts";

type EngineDb = InstanceType<Awaited<ReturnType<typeof loadSqlite3>>["oo1"]["DB"]>;

const BUSY = 5;
const BUSY_TIMEOUT = 773;
const READ_EVERY = 7;
const MAX_BUSY_RETRIES = 100000;

const PARK = new Int32Array(new SharedArrayBuffer(4));

const backoff = (rng: Rng, attempt: number): void => {
  const ms = 1 + rng.int(3) + Math.min(attempt, 25);
  Atomics.wait(PARK, 0, 0, ms);
};

const resultCodeOf = (e: unknown): number | undefined => {
  if (typeof e !== "object" || e === null) return undefined;
  const rc = (e as { resultCode?: unknown }).resultCode;
  return typeof rc === "number" ? rc : undefined;
};

const isBusy = (e: unknown): boolean => {
  const rc = resultCodeOf(e);
  if (rc === undefined) return false;
  return (rc & 0xff) === BUSY || rc === BUSY_TIMEOUT;
};

const args = Deno.args;
const path = args[0] ?? "";
const mode = parseLockingMode(args[1] ?? "xstrict");
const seed = Number(args[2] ?? "1");
const txns = Number(args[3] ?? "100");
const busyTimeoutMs = Number(args[4] ?? "5000");
const workerIndex = Number(args[5] ?? "0");
const driver = parseWorkerDriver(args[6] ?? "engine");

const sqlite3 = await loadSqlite3();
const vfsName = installModeVfs(sqlite3, mode);

const pickTransfer = (rng: Rng): { a: number; b: number; amount: number } => {
  const a = rng.int(ACCOUNTS);
  let b = rng.int(ACCOUNTS);
  if (b === a) b = (b + 1) % ACCOUNTS;
  return { a, b, amount: 1 + rng.int(50) };
};

const transferViaEngine = (db: EngineDb, a: number, b: number, amount: number): "ok" | "busy" => {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec({
      sql: "UPDATE accounts SET balance=balance-$x WHERE id=$a",
      bind: { $x: amount, $a: a },
    });
    db.exec({
      sql: "UPDATE accounts SET balance=balance+$x WHERE id=$b",
      bind: { $x: amount, $b: b },
    });
    db.exec("UPDATE meta SET commit_count=commit_count+1 WHERE id=0");
    db.exec("COMMIT");
    return "ok";
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch { /* the failing statement may have already aborted the txn */ }
    if (isBusy(e)) return "busy";
    throw e;
  }
};

const runViaEngine = (): WorkerResult => {
  const rng = createRng(seed);
  const db = new sqlite3.oo1.DB(path, "w", vfsName);
  let committed = 0;
  let busy = 0;
  let invariantViolation: string | null = null;
  try {
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
    let done = 0;
    while (done < txns) {
      const { a, b, amount } = pickTransfer(rng);
      const outcome = transferViaEngine(db, a, b, amount);
      if (outcome === "busy") {
        busy++;
        continue;
      }
      committed++;
      done++;
      if (done % READ_EVERY === 0) {
        try {
          assertBankInvariant(readBank(db), `worker ${workerIndex} after ${done} commits`);
        } catch (e) {
          invariantViolation = e instanceof Error ? e.message : String(e);
          break;
        }
      }
    }
    if (invariantViolation === null) {
      try {
        assertBankInvariant(readBank(db), `worker ${workerIndex} final`);
      } catch (e) {
        invariantViolation = e instanceof Error ? e.message : String(e);
      }
    }
  } finally {
    db.close();
  }
  return { worker: workerIndex, seed, committed, busy, invariantViolation };
};

const num = (v: SqlValue, label: string): number => {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(`${label} is not numeric: ${String(v)}`);
};

const readBankOnce = (db: Database): BankSnapshot => {
  const tx = db.transaction();
  try {
    const sum = num(
      db.prepare<{ s: SqlValue }>("SELECT coalesce(sum(balance), 0) AS s FROM accounts").get()?.s ??
        0,
      "sum",
    );
    const commitCount = num(
      db.prepare<{ c: SqlValue }>("SELECT commit_count AS c FROM meta WHERE id=0").get()?.c ?? 0,
      "commit_count",
    );
    const balances = db.prepare<{ balance: SqlValue }>(
      "SELECT balance FROM accounts ORDER BY id",
    ).all().map((r) => num(r.balance, "balance"));
    tx.commit();
    return { sum, commitCount, balances };
  } catch (e) {
    tx[Symbol.dispose]();
    throw e;
  }
};

// Under X-strict every read takes the whole-file LOCK_EX (no shared readers), so
// even an observation transaction can BUSY against a concurrent writer. Retry it,
// or a live invariant read would spuriously crash the worker.
const readBankPublic = (db: Database, rng: Rng): BankSnapshot => {
  for (let attempt = 0; attempt < MAX_BUSY_RETRIES; attempt++) {
    try {
      return readBankOnce(db);
    } catch (e) {
      if (!(e instanceof SqliteBusyError)) throw e;
      backoff(rng, attempt);
    }
  }
  throw new Error(
    `worker ${workerIndex} exhausted ${MAX_BUSY_RETRIES} BUSY retries reading the bank`,
  );
};

interface PublicStmts {
  readonly debit: (amount: number, id: number) => void;
  readonly credit: (amount: number, id: number) => void;
  readonly bump: () => void;
}

const transferViaPublic = (
  db: Database,
  stmts: PublicStmts,
  a: number,
  b: number,
  amount: number,
): "ok" | "busy" => {
  const tx = db.transaction();
  try {
    stmts.debit(amount, a);
    stmts.credit(amount, b);
    stmts.bump();
    tx.commit();
    return "ok";
  } catch (e) {
    tx[Symbol.dispose]();
    if (e instanceof SqliteBusyError) return "busy";
    throw e;
  }
};

interface OpenOutcome {
  readonly db: Database;
  readonly busy: number;
}

// `openDatabaseWithVfs` runs `journal_mode=PERSIST` + `synchronous=FULL` during
// open, each of which needs the whole-file X-strict lock. With no busy_timeout on
// the public path, a peer holding the lock makes that configure step throw
// `SqliteBusyError` — Mode 1's serialized-access contract. A real multi-process
// caller retries the open, exactly as it retries a contending transaction().
const openWithRetry = (rng: Rng): OpenOutcome => {
  let busy = 0;
  for (let attempt = 0; attempt < MAX_BUSY_RETRIES; attempt++) {
    try {
      return { db: openDatabaseWithVfs(sqlite3, path, vfsName, {}), busy };
    } catch (e) {
      if (!(e instanceof SqliteBusyError)) throw e;
      busy++;
      backoff(rng, attempt);
    }
  }
  throw new Error(
    `worker ${workerIndex} exhausted ${MAX_BUSY_RETRIES} BUSY retries opening the db`,
  );
};

const runViaPublic = (): WorkerResult => {
  const rng = createRng(seed);
  const opened = openWithRetry(rng);
  using db = opened.db;
  const debitStmt = db.prepare("UPDATE accounts SET balance=balance-? WHERE id=?");
  const creditStmt = db.prepare("UPDATE accounts SET balance=balance+? WHERE id=?");
  const bumpStmt = db.prepare("UPDATE meta SET commit_count=commit_count+1 WHERE id=0");
  const stmts: PublicStmts = {
    debit: (amount, id) => void debitStmt.run(amount, id),
    credit: (amount, id) => void creditStmt.run(amount, id),
    bump: () => void bumpStmt.run(),
  };

  let committed = 0;
  let busy = opened.busy;
  let invariantViolation: string | null = null;
  let done = 0;
  while (done < txns) {
    const { a, b, amount } = pickTransfer(rng);
    let outcome: "ok" | "busy" = "busy";
    for (let attempt = 0; attempt < MAX_BUSY_RETRIES; attempt++) {
      outcome = transferViaPublic(db, stmts, a, b, amount);
      if (outcome === "ok") break;
      busy++;
      backoff(rng, attempt);
    }
    if (outcome !== "ok") {
      invariantViolation =
        `worker ${workerIndex} exhausted ${MAX_BUSY_RETRIES} BUSY retries on one transfer`;
      break;
    }
    committed++;
    done++;
    if (done % READ_EVERY === 0) {
      try {
        assertBankInvariant(readBankPublic(db, rng), `worker ${workerIndex} after ${done} commits`);
      } catch (e) {
        invariantViolation = e instanceof Error ? e.message : String(e);
        break;
      }
    }
  }
  if (invariantViolation === null) {
    try {
      assertBankInvariant(readBankPublic(db, rng), `worker ${workerIndex} final`);
    } catch (e) {
      invariantViolation = e instanceof Error ? e.message : String(e);
    }
  }
  return { worker: workerIndex, seed, committed, busy, invariantViolation };
};

const result = driver === "public" ? runViaPublic() : runViaEngine();
Deno.stdout.writeSync(new TextEncoder().encode(`RESULT ${JSON.stringify(result)}\n`));
