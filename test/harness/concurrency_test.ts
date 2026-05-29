import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { loadSqlite3 } from "../../src/glue.ts";
import {
  installModeVfs,
  integrityOk,
  readBank,
  runConcurrency,
  type RunOptions,
  type RunReport,
  seedBank,
  TOTAL_BALANCE,
} from "./concurrency.ts";

const WORKER = fromFileUrl(import.meta.resolve("../fixtures/concurrency_worker.ts"));
const VICTIM = fromFileUrl(import.meta.resolve("../fixtures/concurrency_victim_worker.ts"));
const CONFIG = fromFileUrl(import.meta.resolve("../../deno.json"));
const SRC = fromFileUrl(import.meta.resolve("../../src/"));

const CI_WORKERS = 6;
const CI_TXNS = 60;
const CI_BUSY_TIMEOUT_MS = 15000;

const SOAK = Deno.env.get("SQLITE_DENO_SOAK") === "1";
const SOAK_WORKERS = Number(Deno.env.get("SQLITE_DENO_SOAK_WORKERS") ?? "16");
const SOAK_TXNS = Number(Deno.env.get("SQLITE_DENO_SOAK_TXNS") ?? "100000");
const SOAK_BUSY_TIMEOUT_MS = 120000;

const withTempDb = async (run: (dbPath: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "conc-" });
  try {
    await run(`${dir}/bank.db`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const baseOptions = (dbPath: string): Omit<RunOptions, "mode" | "workers" | "txnsPerWorker"> => ({
  workerPath: WORKER,
  configPath: CONFIG,
  srcDir: SRC,
  dbPath,
  baseSeed: 0xc0ffee,
  busyTimeoutMs: CI_BUSY_TIMEOUT_MS,
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

Deno.test("X-strict: N processes hammering one DB conserve the bank, keep integrity, and lose no commits", async () => {
  const sqlite3 = await loadSqlite3();
  await withTempDb(async (dbPath) => {
    const report = await runConcurrency(sqlite3, {
      ...baseOptions(dbPath),
      mode: "xstrict",
      workers: CI_WORKERS,
      txnsPerWorker: CI_TXNS,
    });
    assertXstrictHealthy(report);
  });
});

Deno.test("X-strict: every worker makes forward progress (no deadlock starves a process to zero commits)", async () => {
  const sqlite3 = await loadSqlite3();
  await withTempDb(async (dbPath) => {
    const report = await runConcurrency(sqlite3, {
      ...baseOptions(dbPath),
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

Deno.test("negative control: with locking DEFEATED (no-op xLock), the same workload corrupts the bank and the harness DETECTS it", async () => {
  const sqlite3 = await loadSqlite3();
  await withTempDb(async (dbPath) => {
    const report = await runConcurrency(sqlite3, {
      ...baseOptions(dbPath),
      mode: "defeated",
      workers: CI_WORKERS,
      txnsPerWorker: CI_TXNS,
    });
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
  });
});

const PEER_TXNS = 30;
const PEER_COUNT = 2;

const readUntilReady = async (proc: Deno.ChildProcess): Promise<boolean> => {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (!buf.includes("READY")) {
      const { value, done } = await reader.read();
      if (done) return false;
      buf += dec.decode(value);
    }
    return true;
  } finally {
    reader.releaseLock();
  }
};

const spawnConcWorker = (
  path: string,
  mode: string,
  i: number,
  txns: number,
): Deno.ChildProcess => {
  const dir = path.slice(0, path.lastIndexOf("/"));
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      `--config=${CONFIG}`,
      "--no-prompt",
      `--allow-read=${SRC},${dir}`,
      `--allow-write=${dir}`,
      WORKER,
      path,
      mode,
      String(0xbeef + i),
      String(txns),
      String(CI_BUSY_TIMEOUT_MS),
      String(i),
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
};

const spawnVictim = (path: string): Deno.ChildProcess => {
  const dir = path.slice(0, path.lastIndexOf("/"));
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      `--config=${CONFIG}`,
      "--no-prompt",
      `--allow-read=${SRC},${dir}`,
      `--allow-write=${dir}`,
      VICTIM,
      path,
      "xstrict",
    ],
    stdout: "piped",
    stderr: "null",
  }).spawn();
};

Deno.test("crash recovery: a SIGKILLed writer leaves a hot journal that exactly one peer rolls back; invariants hold and the dead txn is gone", async () => {
  const sqlite3 = await loadSqlite3();
  const vfsName = installModeVfs(sqlite3, "xstrict");
  for (let attempt = 0; attempt < 5; attempt++) {
    await withTempDb(async (dbPath) => {
      const seedDb = new sqlite3.oo1.DB(dbPath, "c", vfsName);
      try {
        seedBank(seedDb);
      } finally {
        seedDb.close();
      }

      const victim = spawnVictim(dbPath);
      const ready = await readUntilReady(victim);
      assert(ready, "victim never reached READY — its uncommitted txn never opened");
      const hotJournalBytes = Deno.statSync(`${dbPath}-journal`).size;
      assert(
        hotJournalBytes > 0,
        "no hot -journal on disk at kill time — the recovery path would not be exercised",
      );

      const peers = Array.from(
        { length: PEER_COUNT },
        (_unused, i) => spawnConcWorker(dbPath, "xstrict", i + 10, PEER_TXNS),
      );

      victim.kill("SIGKILL");
      await victim.status;
      await victim.stdout.cancel().catch(() => {});

      const peerResults = await Promise.all(peers.map(async (p) => {
        const out = await new Response(p.stdout).text();
        await new Response(p.stderr).text();
        await p.status;
        const m = out.split("\n").find((l) => l.startsWith("RESULT "));
        return m ? Number(JSON.parse(m.slice(7)).committed) : 0;
      }));
      const peerCommits = peerResults.reduce((a, b) => a + b, 0);

      const db = new sqlite3.oo1.DB(dbPath, "w", vfsName);
      try {
        db.exec("PRAGMA busy_timeout=10000");
        assertEquals(integrityOk(db), "ok", "post-recovery integrity_check/quick_check must be ok");
        const snap = readBank(db);
        assertEquals(
          snap.sum,
          TOTAL_BALANCE,
          `post-recovery SUM(balance) must equal K=${TOTAL_BALANCE} (balances=${
            snap.balances.join(",")
          })`,
        );
        assertEquals(
          snap.commitCount,
          peerCommits,
          "commit_count must equal only the peers' commits — the SIGKILLed txn's increment was rolled back exactly once",
        );
      } finally {
        db.close();
      }
    });
  }
});

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
      });
      assertXstrictHealthy(report);
    });
  },
});
