import type { Sqlite3 } from "../../src/glue.ts";
import type { FilePtr, OutPtr } from "../../src/wasm/ptr.ts";
import { asIoMethodsArg, asVfsMethodsArg } from "../../src/vfs/types.ts";
import type { IoMethods } from "../../src/vfs/types.ts";
import { resultCodes } from "../../src/vfs/errors.ts";
import { createIoMethods, type OpenRegistry } from "../../src/vfs/io.ts";
import { createVfsMethods } from "../../src/vfs/namespace.ts";

export const LOCKING_MODES = ["xstrict", "defeated"] as const;
export type LockingMode = (typeof LOCKING_MODES)[number];

const isLockingMode = (v: string): v is LockingMode =>
  (LOCKING_MODES as readonly string[]).includes(v);

export const parseLockingMode = (v: string): LockingMode => {
  if (isLockingMode(v)) return v;
  throw new Error(`unknown locking mode: ${v}`);
};

export const ACCOUNTS = 8;
export const INITIAL_BALANCE = 1000;
export const TOTAL_BALANCE = ACCOUNTS * INITIAL_BALANCE;

const MAX_PATHNAME = 1024;

/**
 * Registers a Mode-1 VFS that reuses the real `createIoMethods`/`createVfsMethods`
 * but lets the harness pick the lock protocol. `xstrict` is the shipped DEC-009
 * ladder verbatim (real `xLock`/`xUnlock`/`xCheckReservedLock`); `defeated` swaps
 * only those three callbacks for no-ops, reproducing the Phase-3
 * concurrent-unsynchronized-writers behaviour that is the mandatory negative
 * control. `src/` is never touched — the override wraps the public `IoMethods`
 * object after `createIoMethods` builds it, so the no-op seam exists solely in
 * test code (DEC-009 negative-control discipline).
 *
 * Each mode gets a distinct VFS name so a process can register either without
 * the `sqlite3_vfs_find` early-return colliding.
 */
export const installModeVfs = (sqlite3: Sqlite3, mode: LockingMode): string => {
  const vfsName = `deno-fs-conc-${mode}`;
  const { capi, wasm, struct } = sqlite3;
  if (capi.sqlite3_vfs_find(vfsName)) return vfsName;

  const rc = resultCodes(sqlite3);
  const open: OpenRegistry = new Map();

  const asFile = (p: number): FilePtr => p as FilePtr;
  const asOut = (p: number): OutPtr => p as OutPtr;

  const ioMethods = struct.ioMethods();
  ioMethods.$iVersion = 1;
  const realIo = createIoMethods(sqlite3, open, rc);
  const io: IoMethods = mode === "defeated"
    ? {
      ...realIo,
      xLock: (pFile: number, _lockType: number): number =>
        open.has(asFile(pFile)) ? rc.ok : rc.ioErrLock,
      xUnlock: (pFile: number, _lockType: number): number =>
        open.has(asFile(pFile)) ? rc.ok : rc.ioErrUnlock,
      xCheckReservedLock: (pFile: number, pResOut: number): number => {
        if (!open.has(asFile(pFile))) return rc.ioErrCheckReservedLock;
        wasm.poke32(asOut(pResOut), 0);
        return rc.ok;
      },
    }
    : realIo;

  const probe = struct.file();
  const szOsFile = probe.structInfo.sizeof;
  probe.dispose();

  const setPMethods = (pFile: number, ptr: number): void => {
    const sq3File = struct.file(pFile);
    sq3File.$pMethods = ptr;
    sq3File.dispose();
  };

  const vfsStruct = struct.vfs();
  vfsStruct.$iVersion = 2;
  vfsStruct.$szOsFile = szOsFile;
  vfsStruct.$mxPathname = MAX_PATHNAME;

  const dfltPtr = capi.sqlite3_vfs_find(null);
  if (dfltPtr) {
    const dflt = struct.vfs(dfltPtr);
    vfsStruct.$xRandomness = dflt.$xRandomness;
    vfsStruct.$xSleep = dflt.$xSleep;
    vfsStruct.$xCurrentTime = dflt.$xCurrentTime;
    vfsStruct.$xCurrentTimeInt64 = dflt.$xCurrentTimeInt64;
    dflt.dispose();
  }

  const vfs = createVfsMethods({
    sqlite3,
    open,
    rc,
    ioMethodsPtr: ioMethods.pointer,
    setPMethods,
  });

  const zName = wasm.allocCString(vfsName, false);
  vfsStruct.$zName = zName;
  vfsStruct.addOnDispose(zName);
  sqlite3.vfs.installVfs({ io: { struct: ioMethods, methods: asIoMethodsArg(io) } });
  sqlite3.vfs.installVfs({ vfs: { struct: vfsStruct, methods: asVfsMethodsArg(vfs) } });
  return vfsName;
};

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

/**
 * Reads the whole bank inside one deferred read transaction so the sum, the
 * per-row balances, and `commit_count` come from a single consistent point —
 * the torn-read detector depends on the read being atomic with respect to any
 * concurrent transfer.
 */
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
  for (const line of out.split("\n")) {
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

/**
 * Seeds the bank, spawns `workers` real OS subprocesses that hammer the one DB
 * file in Mode 1, collects each worker's self-reported invariant verdict, then
 * reopens the DB in the parent and verifies the end-of-run invariants:
 * balance-sum conservation, `integrity_check`/`quick_check` = ok, and the
 * monotonic-commit predicate (`commit_count` == total driver-tracked commits).
 * The DB directory is `dirname(dbPath)`; the caller owns its lifecycle.
 */
export const runConcurrency = async (
  sqlite3: Sqlite3,
  opts: RunOptions,
): Promise<RunReport> => {
  const dir = dirOf(opts.dbPath);
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

/**
 * Reopens the DB in the parent for the end-of-run verdict. A negative-control
 * run can leave the file so corrupt that `integrity_check` or even reading the
 * bank throws — that is a *detected* corruption, not a harness fault, so the
 * thrown message becomes the `integrity` verdict and the snapshot reads as the
 * sentinel that fails every conservation check.
 */
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

const dirOf = (p: string): string => {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
};
