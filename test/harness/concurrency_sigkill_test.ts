import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { loadSqlite3 } from "../../src/glue.ts";
import {
  installModeVfs,
  integrityOk,
  readBank,
  seedBank,
  TOTAL_BALANCE,
  type WorkerDriver,
} from "./concurrency.ts";

const WORKER = fromFileUrl(import.meta.resolve("../fixtures/concurrency_worker.ts"));
const VICTIM = fromFileUrl(import.meta.resolve("../fixtures/concurrency_victim_worker.ts"));
const CONFIG = fromFileUrl(import.meta.resolve("../../deno.json"));
const SRC = fromFileUrl(import.meta.resolve("../../src/"));

const CI_BUSY_TIMEOUT_MS = 15000;
const PEER_TXNS = 30;
const PEER_COUNT = 2;
const ATTEMPTS = 5;

const withTempDb = async (run: (dbPath: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "conc-sigkill-" });
  try {
    await run(`${dir}/bank.db`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

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
  i: number,
  txns: number,
  driver: WorkerDriver,
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
      "xstrict",
      String(0xbeef + i),
      String(txns),
      String(CI_BUSY_TIMEOUT_MS),
      String(i),
      driver,
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

Deno.test("PUBLIC API crash recovery: a SIGKILLed writer leaves a hot journal that public-API peers (openDatabase + db.transaction()) roll back; invariants hold and the dead txn is gone", async () => {
  const sqlite3 = await loadSqlite3();
  const vfsName = installModeVfs(sqlite3, "xstrict");
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
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
        (_unused, i) => spawnConcWorker(dbPath, i + 10, PEER_TXNS, "public"),
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
