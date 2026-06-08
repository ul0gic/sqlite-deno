import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { loadSqlite3 } from "../../src/glue.ts";
import {
  runConcurrency,
  type RunOptions,
  type RunReport,
  TOTAL_BALANCE,
  type WorkerDriver,
} from "./concurrency.ts";

const WORKER = fromFileUrl(import.meta.resolve("../fixtures/concurrency_worker.ts"));
const CONFIG = fromFileUrl(import.meta.resolve("../../deno.json"));
const SRC = fromFileUrl(import.meta.resolve("../../src/"));

const CI_WORKERS = 6;
const CI_TXNS = 60;
const CI_BUSY_TIMEOUT_MS = 15000;

const SOAK = Deno.env.get("SQLITE_DENO_SOAK") === "1";
const SOAK_WORKERS = Number(Deno.env.get("SQLITE_DENO_SOAK_WORKERS") ?? "16");
const SOAK_TXNS = Number(Deno.env.get("SQLITE_DENO_SOAK_TXNS") ?? "100000");
const SOAK_DRIVER: WorkerDriver = Deno.env.get("SQLITE_DENO_SOAK_DRIVER") === "engine"
  ? "engine"
  : "public";
const SOAK_BUSY_TIMEOUT_MS = 120000;

const withTempDb = async (run: (dbPath: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "conc-" });
  try {
    await run(`${dir}/bank.db`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const baseOptions = (
  dbPath: string,
  driver: WorkerDriver,
): Omit<RunOptions, "mode" | "workers" | "txnsPerWorker"> => ({
  workerPath: WORKER,
  configPath: CONFIG,
  srcDir: SRC,
  dbPath,
  baseSeed: 0xc0ffee,
  busyTimeoutMs: CI_BUSY_TIMEOUT_MS,
  driver,
});

const assertXstrictHealthy = (report: RunReport): void => {
  assertEquals(
    report.crashes,
    [],
    `under X-strict no worker may crash; crashes: ${
      report.crashes.map((c) => `w${c.worker} code=${c.code} ${c.stderr}`).join(" | ")
    }`,
  );
  for (const r of report.results) {
    assertEquals(
      r.invariantViolation,
      null,
      `worker ${r.worker} (seed ${r.seed}) reported an in-flight invariant violation`,
    );
  }
  assertEquals(report.integrity, "ok", "end-of-run integrity_check/quick_check must be ok");
  assertEquals(
    report.finalSnapshot.sum,
    TOTAL_BALANCE,
    `end-of-run SUM(balance) must equal K=${TOTAL_BALANCE}`,
  );
  assertEquals(
    report.finalSnapshot.commitCount,
    report.totalCommitted,
    "commit_count must equal the total driver-tracked successful commits (no lost/resurrected commits)",
  );
  assert(report.totalCommitted > 0, "workers must have committed at least one transfer");
};

const assertNegativeControlDetected = (report: RunReport): void => {
  const workerCaught = report.results.some((r) => r.invariantViolation !== null);
  const workerCrashed = report.crashes.length > 0;
  const sumBroken = report.finalSnapshot.sum !== TOTAL_BALANCE;
  const integrityBroken = report.integrity !== "ok";
  const commitsLost = report.finalSnapshot.commitCount !== report.totalCommitted;
  assert(
    workerCaught || workerCrashed || sumBroken || integrityBroken || commitsLost,
    `negative control stayed clean — the harness cannot detect corruption. ` +
      `integrity=${report.integrity} sum=${report.finalSnapshot.sum}/${TOTAL_BALANCE} ` +
      `commitCount=${report.finalSnapshot.commitCount} tracked=${report.totalCommitted} crashes=${report.crashes.length}`,
  );
};

Deno.test("ENGINE X-strict: N processes hammering one DB conserve the bank, keep integrity, and lose no commits", async () => {
  const sqlite3 = await loadSqlite3();
  await withTempDb(async (dbPath) => {
    const report = await runConcurrency(sqlite3, {
      ...baseOptions(dbPath, "engine"),
      mode: "xstrict",
      workers: CI_WORKERS,
      txnsPerWorker: CI_TXNS,
    });
    assertXstrictHealthy(report);
  });
});

Deno.test("ENGINE X-strict: every worker makes forward progress (no deadlock starves a process to zero commits)", async () => {
  const sqlite3 = await loadSqlite3();
  await withTempDb(async (dbPath) => {
    const report = await runConcurrency(sqlite3, {
      ...baseOptions(dbPath, "engine"),
      mode: "xstrict",
      workers: CI_WORKERS,
      txnsPerWorker: CI_TXNS,
    });
    for (const r of report.results) {
      assert(
        r.committed === CI_TXNS,
        `worker ${r.worker} committed ${r.committed}/${CI_TXNS} — a starved worker never reached its quota`,
      );
    }
  });
});

Deno.test("ENGINE negative control: with locking DEFEATED (no-op xLock), the same workload corrupts the bank and the harness DETECTS it", async () => {
  const sqlite3 = await loadSqlite3();
  await withTempDb(async (dbPath) => {
    const report = await runConcurrency(sqlite3, {
      ...baseOptions(dbPath, "engine"),
      mode: "defeated",
      workers: CI_WORKERS,
      txnsPerWorker: CI_TXNS,
    });
    assertNegativeControlDetected(report);
  });
});

Deno.test(
  "PUBLIC API X-strict: N processes drive openDatabase + db.transaction()/run, conserve the bank, keep integrity, and lose no commits (the savepoint factory + SqliteBusyError retry under real contention)",
  async () => {
    const sqlite3 = await loadSqlite3();
    await withTempDb(async (dbPath) => {
      const report = await runConcurrency(sqlite3, {
        ...baseOptions(dbPath, "public"),
        mode: "xstrict",
        workers: CI_WORKERS,
        txnsPerWorker: CI_TXNS,
      });
      assertXstrictHealthy(report);
      const totalBusy = report.results.reduce((acc, r) => acc + r.busy, 0);
      assert(
        totalBusy > 0,
        "no worker ever caught a SqliteBusyError — the public-API retry path (openDatabase sets no busy_timeout, so a contending transaction() must surface SQLITE_BUSY) was never exercised, so this proves nothing under contention",
      );
    });
  },
);

Deno.test(
  "PUBLIC API X-strict: every worker reaches its commit quota through the public retry path (no transaction() deadlocks or starves a process to zero)",
  async () => {
    const sqlite3 = await loadSqlite3();
    await withTempDb(async (dbPath) => {
      const report = await runConcurrency(sqlite3, {
        ...baseOptions(dbPath, "public"),
        mode: "xstrict",
        workers: CI_WORKERS,
        txnsPerWorker: CI_TXNS,
      });
      for (const r of report.results) {
        assert(
          r.committed === CI_TXNS,
          `worker ${r.worker} committed ${r.committed}/${CI_TXNS} through the public API — a starved worker never reached its quota`,
        );
      }
    });
  },
);

Deno.test(
  "PUBLIC API negative control: with locking DEFEATED, openDatabase + db.transaction() workers corrupt the bank and the harness DETECTS it",
  async () => {
    const sqlite3 = await loadSqlite3();
    await withTempDb(async (dbPath) => {
      const report = await runConcurrency(sqlite3, {
        ...baseOptions(dbPath, "public"),
        mode: "defeated",
        workers: CI_WORKERS,
        txnsPerWorker: CI_TXNS,
      });
      assertNegativeControlDetected(report);
    });
  },
);

Deno.test({
  name: "SOAK: millions of ops under CPU oversubscription (env-gated SQLITE_DENO_SOAK=1)",
  ignore: !SOAK,
  fn: async () => {
    const sqlite3 = await loadSqlite3();
    await withTempDb(async (dbPath) => {
      const report = await runConcurrency(sqlite3, {
        workerPath: WORKER,
        configPath: CONFIG,
        srcDir: SRC,
        dbPath,
        baseSeed: 0xc0ffee,
        busyTimeoutMs: SOAK_BUSY_TIMEOUT_MS,
        mode: "xstrict",
        workers: SOAK_WORKERS,
        txnsPerWorker: SOAK_TXNS,
        driver: SOAK_DRIVER,
      });
      assertXstrictHealthy(report);
    });
  },
});
