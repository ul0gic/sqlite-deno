import { dirname } from "@std/path";
import type { Sqlite3 } from "../../src/glue.ts";
import { installModeVfs, type LockingMode } from "./concurrency-vfs.ts";

export {
  installModeVfs,
  LOCKING_MODES,
  type LockingMode,
  parseLockingMode,
} from "./concurrency-vfs.ts";

/** `engine` = oo1.DB floor with manual BEGIN IMMEDIATE/busy-retry; `public` = shipped API path. */
export const WORKER_DRIVERS = ["engine", "public"] as const;
export type WorkerDriver = (typeof WORKER_DRIVERS)[number];

const isWorkerDriver = (v: string): v is WorkerDriver =>
  (WORKER_DRIVERS as readonly string[]).includes(v);

export const parseWorkerDriver = (v: string): WorkerDriver => {
  if (isWorkerDriver(v)) return v;
  throw new Error(`unknown worker driver: ${v}`);
};

export const ACCOUNTS = 8;
export const INITIAL_BALANCE = 1000;
export const TOTAL_BALANCE = ACCOUNTS * INITIAL_BALANCE;

type Db = InstanceType<Sqlite3["oo1"]["DB"]>;

const num = (v: unknown, label: string): number => {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(`${label} is not numeric: ${String(v)}`);
};

export const seedBank = (db: Db): void => {
  db.exec("PRAGMA journal_mode=DELETE");
  db.exec("CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY, balance INTEGER NOT NULL)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=0), commit_count INTEGER NOT NULL)",
  );
  db.exec("BEGIN IMMEDIATE");
  for (let id = 0; id < ACCOUNTS; id++) {
    db.exec({
      sql: "INSERT INTO accounts(id, balance) VALUES ($id, $b)",
      bind: { $id: id, $b: INITIAL_BALANCE },
    });
  }
  db.exec({ sql: "INSERT INTO meta(id, commit_count) VALUES (0, 0)", bind: {} });
  db.exec("COMMIT");
};

export interface BankSnapshot {
  readonly sum: number;
  readonly commitCount: number;
  readonly balances: readonly number[];
}

// One deferred read txn so sum, balances, and commit_count are atomic vs concurrent transfers.
export const readBank = (db: Db): BankSnapshot => {
  db.exec("BEGIN");
  try {
    const sum = num(db.selectValue("SELECT coalesce(sum(balance), 0) FROM accounts"), "sum");
    const commitCount = num(
      db.selectValue("SELECT commit_count FROM meta WHERE id=0"),
      "commit_count",
    );
    const balances: number[] = [];
    db.exec({
      sql: "SELECT balance FROM accounts ORDER BY id",
      rowMode: "array",
      callback: (row) => void balances.push(num(row[0], "balance")),
    });
    return { sum, commitCount, balances };
  } finally {
    db.exec("COMMIT");
  }
};

export const assertBankInvariant = (snap: BankSnapshot, where: string): void => {
  if (snap.sum !== TOTAL_BALANCE) {
    throw new Error(
      `[I1 balance-sum] ${where}: SUM(balance)=${snap.sum} != ${TOTAL_BALANCE} (balances=${
        snap.balances.join(",")
      })`,
    );
  }
  for (const b of snap.balances) {
    if (!Number.isInteger(b)) throw new Error(`[I3 torn-read] ${where}: non-integer balance ${b}`);
  }
};

export const integrityOk = (db: Db): string => {
  const quick = db.selectValue("PRAGMA quick_check");
  if (quick !== "ok") return `quick_check=${String(quick)}`;
  const full = db.selectValue("PRAGMA integrity_check");
  if (full !== "ok") return `integrity_check=${String(full)}`;
  return "ok";
};

export interface WorkerResult {
  readonly worker: number;
  readonly seed: number;
  readonly committed: number;
  readonly busy: number;
  readonly invariantViolation: string | null;
}

const parseWorkerResult = (line: string): WorkerResult | undefined => {
  if (!line.startsWith("RESULT ")) return undefined;
  const obj: unknown = JSON.parse(line.slice("RESULT ".length));
  if (typeof obj !== "object" || obj === null) return undefined;
  const r = obj as Record<string, unknown>;
  if (
    typeof r["worker"] !== "number" || typeof r["seed"] !== "number" ||
    typeof r["committed"] !== "number" || typeof r["busy"] !== "number"
  ) return undefined;
  const iv = r["invariantViolation"];
  return {
    worker: r["worker"],
    seed: r["seed"],
    committed: r["committed"],
    busy: r["busy"],
    invariantViolation: typeof iv === "string" ? iv : null,
  };
};

export type WorkerOutcome =
  | { readonly kind: "result"; readonly result: WorkerResult }
  | {
    readonly kind: "crash";
    readonly worker: number;
    readonly code: number;
    readonly stderr: string;
  };

const collectOutcome = async (proc: Deno.ChildProcess, worker: number): Promise<WorkerOutcome> => {
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.status;
  for (const line of out.split(/\r?\n/)) {
    const r = parseWorkerResult(line);
    if (r) return { kind: "result", result: r };
  }
  return { kind: "crash", worker, code: status.code, stderr: err.slice(-512) };
};

export interface RunOptions {
  readonly workerPath: string;
  readonly configPath: string;
  readonly srcDir: string;
  readonly dbPath: string;
  readonly mode: LockingMode;
  readonly workers: number;
  readonly txnsPerWorker: number;
  readonly baseSeed: number;
  readonly busyTimeoutMs: number;
  readonly driver: WorkerDriver;
}

const spawnWorker = (opts: RunOptions, dir: string, i: number): Deno.ChildProcess =>
  new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      `--config=${opts.configPath}`,
      "--no-prompt",
      `--allow-read=${opts.srcDir},${dir}`,
      `--allow-write=${dir}`,
      opts.workerPath,
      opts.dbPath,
      opts.mode,
      String(opts.baseSeed + i),
      String(opts.txnsPerWorker),
      String(opts.busyTimeoutMs),
      String(i),
      opts.driver,
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

export interface RunReport {
  readonly outcomes: readonly WorkerOutcome[];
  readonly results: readonly WorkerResult[];
  readonly crashes: readonly {
    readonly worker: number;
    readonly code: number;
    readonly stderr: string;
  }[];
  readonly totalCommitted: number;
  readonly finalSnapshot: BankSnapshot;
  readonly integrity: string;
}

export const runConcurrency = async (
  sqlite3: Sqlite3,
  opts: RunOptions,
): Promise<RunReport> => {
  const dir = dirname(opts.dbPath);
  const vfsName = installModeVfs(sqlite3, opts.mode);
  const seedDb = new sqlite3.oo1.DB(opts.dbPath, "c", vfsName);
  try {
    seedBank(seedDb);
  } finally {
    seedDb.close();
  }

  const procs: Deno.ChildProcess[] = [];
  for (let i = 0; i < opts.workers; i++) procs.push(spawnWorker(opts, dir, i));
  const outcomes = await Promise.all(procs.map((p, i) => collectOutcome(p, i)));

  const results: WorkerResult[] = [];
  const crashes: { worker: number; code: number; stderr: string }[] = [];
  for (const o of outcomes) {
    if (o.kind === "result") results.push(o.result);
    else crashes.push({ worker: o.worker, code: o.code, stderr: o.stderr });
  }
  const totalCommitted = results.reduce((acc, r) => acc + r.committed, 0);

  const { integrity, finalSnapshot } = inspectFinal(sqlite3, opts.dbPath, vfsName);
  return { outcomes, results, crashes, totalCommitted, finalSnapshot, integrity };
};

const CORRUPT_SNAPSHOT: BankSnapshot = { sum: -1, commitCount: -1, balances: [] };

// A throw here is detected corruption, not a harness fault: surface it as the verdict + sentinel.
const inspectFinal = (
  sqlite3: Sqlite3,
  dbPath: string,
  vfsName: string,
): { integrity: string; finalSnapshot: BankSnapshot } => {
  let db: Db | undefined;
  try {
    db = new sqlite3.oo1.DB(dbPath, "w", vfsName);
    db.exec("PRAGMA busy_timeout=10000");
    const integrity = integrityOk(db);
    const finalSnapshot = readBank(db);
    return { integrity, finalSnapshot };
  } catch (e) {
    return {
      integrity: `reopen-threw: ${e instanceof Error ? e.message : String(e)}`,
      finalSnapshot: CORRUPT_SNAPSHOT,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch { /* a corrupt handle may already be unusable */ }
    }
  }
};
