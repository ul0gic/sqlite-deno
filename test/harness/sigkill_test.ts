import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { loadSqlite3 } from "../../src/glue.ts";
import { DENO_VFS_NAME, installDenoVfs } from "../../src/vfs/deno.ts";

const WORKER = fromFileUrl(import.meta.resolve("../fixtures/crash_writer_worker.ts"));
const CONFIG = fromFileUrl(import.meta.resolve("../../deno.json"));
const ITERATIONS = 6;

const readUntilReady = async (proc: Deno.ChildProcess): Promise<void> => {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (!buf.includes("READY")) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value);
    }
  } finally {
    reader.releaseLock();
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const inspect = (sqlite3: Awaited<ReturnType<typeof loadSqlite3>>, path: string): number => {
  installDenoVfs(sqlite3);
  const db = new sqlite3.oo1.DB(path, "c", DENO_VFS_NAME);
  try {
    assertEquals(db.selectValue("PRAGMA integrity_check"), "ok", `integrity_check after SIGKILL`);
    const present = db.selectValue("SELECT count(*) FROM kv");
    assert(typeof present === "number", "row count must be an integer");
    const maxV = db.selectValue("SELECT coalesce(max(v), 0) FROM kv");
    const distinct = db.selectValue("SELECT count(DISTINCT v) FROM kv");
    assertEquals(present, distinct, "no duplicate committed values (torn commit)");
    assert(
      typeof maxV === "number" && maxV >= present,
      "committed values stay within issued range",
    );
    return present;
  } finally {
    db.close();
  }
};

Deno.test("SIGKILL mid-write: the file DB reopens with integrity_check=ok and no torn commits", async () => {
  const sqlite3 = await loadSqlite3();
  for (let i = 0; i < ITERATIONS; i++) {
    const dir = await Deno.makeTempDir({ prefix: "sigkill-" });
    try {
      const dbPath = `${dir}/kill.db`;
      const proc = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          `--config=${CONFIG}`,
          "--no-prompt",
          `--allow-read=${fromFileUrl(import.meta.resolve("../../src/"))},${dir}`,
          `--allow-write=${dir}`,
          WORKER,
          dbPath,
        ],
        stdout: "piped",
        stderr: "null",
      }).spawn();

      try {
        await readUntilReady(proc);
        await sleep(20 + i * 7);
        proc.kill("SIGKILL");
      } finally {
        await proc.status;
        try {
          await proc.stdout.cancel();
        } catch { /* already released */ }
      }

      const present = inspect(sqlite3, dbPath);
      assert(present >= 0, "row count is non-negative");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
