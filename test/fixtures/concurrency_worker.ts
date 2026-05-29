import { loadSqlite3 } from "../../src/glue.ts";
import {
  ACCOUNTS,
  assertBankInvariant,
  installModeVfs,
  parseLockingMode,
  readBank,
  type WorkerResult,
} from "../harness/concurrency.ts";
import { createRng } from "../harness/rng.ts";

type Db = InstanceType<Awaited<ReturnType<typeof loadSqlite3>>["oo1"]["DB"]>;

const BUSY = 5;
const BUSY_TIMEOUT = 773;
const READ_EVERY = 7;

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

const sqlite3 = await loadSqlite3();
const vfsName = installModeVfs(sqlite3, mode);

const transferOnce = (db: Db, a: number, b: number, amount: number): "ok" | "busy" => {
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

const run = (): WorkerResult => {
  const rng = createRng(seed);
  const db = new sqlite3.oo1.DB(path, "w", vfsName);
  let committed = 0;
  let busy = 0;
  let invariantViolation: string | null = null;
  try {
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
    let done = 0;
    while (done < txns) {
      const a = rng.int(ACCOUNTS);
      let b = rng.int(ACCOUNTS);
      if (b === a) b = (b + 1) % ACCOUNTS;
      const amount = 1 + rng.int(50);
      const outcome = transferOnce(db, a, b, amount);
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

const result = run();
Deno.stdout.writeSync(new TextEncoder().encode(`RESULT ${JSON.stringify(result)}\n`));
