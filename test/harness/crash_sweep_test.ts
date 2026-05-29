import { assert, assertEquals } from "@std/assert";
import { loadSqlite3 } from "../../src/glue.ts";
import { installCrashVfs } from "./crash-vfs.ts";
import { runSweep } from "./sweep.ts";

const SEEDS = [1, 7, 1337, 90210, 2654435761] as const;

const withSweepVfs = async <T>(
  vfsName: string,
  realSync: boolean,
  fn: (
    sqlite3: Awaited<ReturnType<typeof loadSqlite3>>,
    recorder: ReturnType<typeof installCrashVfs>,
    dir: string,
  ) => T | Promise<T>,
): Promise<T> => {
  const sqlite3 = await loadSqlite3();
  const recorder = installCrashVfs(sqlite3, { vfsName, realSync });
  const dir = await Deno.makeTempDir({ prefix: "crash-sweep-" });
  try {
    return await fn(sqlite3, recorder, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const fmtFailures = (
  failures: readonly { crashIndex: number; variant: string; subSeed: number; detail: string }[],
): string =>
  failures
    .slice(0, 8)
    .map((f) => `k=${f.crashIndex} ${f.variant} subSeed=${f.subSeed}: ${f.detail}`)
    .join("\n");

Deno.test("content power-loss sweep: every crash point keeps committed txns and integrity", async () => {
  await withSweepVfs("crash-sweep-content", true, (sqlite3, recorder, dir) => {
    for (const seed of SEEDS) {
      const res = runSweep(sqlite3, recorder, dir, {
        spec: { txns: 5, rowsPerTxn: 2, dbName: "/sweep.db" },
        seed,
        reconstructionsPerPoint: 6,
        dentryDurable: true,
      });
      assert(res.crashPoints > 20, `seed ${seed} swept too few crash points: ${res.crashPoints}`);
      assertEquals(
        res.failures.length,
        0,
        `seed ${seed} produced ${res.failures.length} I1/I2 failures across ${res.reconstructions} reconstructions:\n${
          fmtFailures(res.failures)
        }`,
      );
    }
  });
});

Deno.test("content power-loss sweep survives a write-heavy multi-row workload", async () => {
  await withSweepVfs("crash-sweep-heavy", true, (sqlite3, recorder, dir) => {
    const seed = 0x5eed;
    const res = runSweep(sqlite3, recorder, dir, {
      spec: { txns: 3, rowsPerTxn: 8, dbName: "/heavy.db" },
      seed,
      reconstructionsPerPoint: 8,
      dentryDurable: true,
    });
    assertEquals(
      res.failures.length,
      0,
      `seed ${seed} produced failures:\n${fmtFailures(res.failures)}`,
    );
  });
});

Deno.test("negative control: a lying no-op xSync is CAUGHT by the harness", async () => {
  await withSweepVfs("crash-sweep-noopsync", false, (sqlite3, recorder, dir) => {
    const res = runSweep(sqlite3, recorder, dir, {
      spec: { txns: 4, rowsPerTxn: 2, dbName: "/lie.db" },
      seed: 424242,
      reconstructionsPerPoint: 6,
      dentryDurable: true,
    });
    assert(
      res.failures.length > 0,
      `harness FAILED to catch a broken xSync — it cannot detect corruption, so it proves nothing (recon=${res.reconstructions})`,
    );
    assert(
      res.failures.some((f) => f.detail.startsWith("I1")),
      "expected at least one integrity (I1) failure from unsynced corruption",
    );
  });
});
