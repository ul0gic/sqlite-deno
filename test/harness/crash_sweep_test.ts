import { assert, assertEquals } from "@std/assert";
import { loadSqlite3 } from "../../src/glue.ts";
import { installCrashVfs } from "./crash-vfs.ts";
import { runSweep } from "./sweep.ts";
import { PUBLIC_API_DRIVER, PUBLIC_API_NORMAL_DRIVER } from "./workload.ts";
import { PUBLIC_API_READBACK } from "./verify.ts";

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

type Failure = { crashIndex: number; variant: string; subSeed: number; detail: string };

const fmtFailures = (failures: readonly Failure[]): string =>
  failures
    .slice(0, 8)
    .map((f) => `k=${f.crashIndex} ${f.variant} subSeed=${f.subSeed}: ${f.detail}`)
    .join("\n");

const integrityFailures = (failures: readonly Failure[]): readonly Failure[] =>
  failures.filter((f) => f.detail.startsWith("I1"));

const commitLossFailures = (failures: readonly Failure[]): readonly Failure[] =>
  failures.filter((f) => f.detail.includes("lost committed"));

Deno.test("content power-loss sweep: every crash point keeps committed txns and integrity", async () => {
  await withSweepVfs("crash-sweep-content", true, async (sqlite3, recorder, dir) => {
    for (const seed of SEEDS) {
      const res = await runSweep(sqlite3, recorder, dir, {
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
  await withSweepVfs("crash-sweep-heavy", true, async (sqlite3, recorder, dir) => {
    const seed = 0x5eed;
    const res = await runSweep(sqlite3, recorder, dir, {
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

Deno.test(
  "PUBLIC API power-loss sweep (shipped default, durability=full): openDatabase keeps EVERY committed txn and stays corruption-free at every crash point",
  async () => {
    await withSweepVfs("crash-sweep-public", true, async (sqlite3, recorder, dir) => {
      for (const seed of SEEDS) {
        const res = await runSweep(sqlite3, recorder, dir, {
          spec: { txns: 5, rowsPerTxn: 2, dbName: "/public.db" },
          seed,
          reconstructionsPerPoint: 6,
          dentryDurable: true,
          workloadDriver: PUBLIC_API_DRIVER,
          readbackDriver: PUBLIC_API_READBACK,
        });
        assert(
          res.crashPoints > 20,
          `seed ${seed} swept too few crash points: ${res.crashPoints}`,
        );
        assertEquals(
          integrityFailures(res.failures).length,
          0,
          `seed ${seed}: openDatabase reopen produced a CORRUPT (I1) database through the public API across ${res.reconstructions} reconstructions — integrity must hold at every crash point:\n${
            fmtFailures(integrityFailures(res.failures))
          }`,
        );
        // BUG-004 fix: the shipped rollback default is now synchronous=FULL, which
        // adds the journal-header sync that closes the torn-next-txn-journal window.
        // FULL is durable — ZERO committed-txn loss through the public API. If this
        // ever regresses (>0), the default silently dropped back to NORMAL.
        assertEquals(
          commitLossFailures(res.failures).length,
          0,
          `seed ${seed}: the durable default (durability=full) LOST a committed txn through the public API across ${res.reconstructions} reconstructions — BUG-004 regressed (default reverted to synchronous=NORMAL?):\n${
            fmtFailures(commitLossFailures(res.failures))
          }`,
        );
      }
    });
  },
);

Deno.test(
  "PUBLIC API power-loss sweep (explicit durability=normal): integrity holds everywhere, but the LAST committed txn can still be lost (the documented weaker opt-in)",
  async () => {
    await withSweepVfs("crash-sweep-public-normal", true, async (sqlite3, recorder, dir) => {
      let commitLoss = 0;
      for (const seed of SEEDS) {
        const res = await runSweep(sqlite3, recorder, dir, {
          spec: { txns: 5, rowsPerTxn: 2, dbName: "/publicnormal.db" },
          seed,
          reconstructionsPerPoint: 6,
          dentryDurable: true,
          workloadDriver: PUBLIC_API_NORMAL_DRIVER,
          readbackDriver: PUBLIC_API_READBACK,
        });
        assertEquals(
          integrityFailures(res.failures).length,
          0,
          `seed ${seed}: durability=normal must still be consistency-safe (no CORRUPT/I1 database) through the public API:\n${
            fmtFailures(integrityFailures(res.failures))
          }`,
        );
        commitLoss += commitLossFailures(res.failures).length;
      }
      // Pins the FULL-vs-NORMAL distinction as a permanent fact proven through the
      // shipped surface: NORMAL is the documented weaker opt-in — it can drop the
      // latest committed txn on a torn next-txn journal (integrity intact). If this
      // stops reproducing, either the opt-in stopped reaching synchronous=NORMAL or
      // the crash model stopped resurrecting the torn journal — do not relax it.
      assert(
        commitLoss > 0,
        "durability=normal stopped losing a committed txn through the public API — the FULL-vs-NORMAL durability distinction is no longer demonstrated; do not silently relax this.",
      );
    });
  },
);

Deno.test(
  "PUBLIC API sweep: a transaction-heavy workload (prepare/run + savepoint transaction) stays corruption-free (I1) at every crash point",
  async () => {
    await withSweepVfs("crash-sweep-public-heavy", true, async (sqlite3, recorder, dir) => {
      const seed = 0x9a11;
      const res = await runSweep(sqlite3, recorder, dir, {
        spec: { txns: 3, rowsPerTxn: 8, dbName: "/publicheavy.db" },
        seed,
        reconstructionsPerPoint: 8,
        dentryDurable: true,
        workloadDriver: PUBLIC_API_DRIVER,
        readbackDriver: PUBLIC_API_READBACK,
      });
      assertEquals(
        integrityFailures(res.failures).length,
        0,
        `seed ${seed}: the public prepare/run + savepoint path produced a CORRUPT (I1) database:\n${
          fmtFailures(integrityFailures(res.failures))
        }`,
      );
    });
  },
);

Deno.test("negative control: a lying no-op xSync is CAUGHT by the harness", async () => {
  await withSweepVfs("crash-sweep-noopsync", false, async (sqlite3, recorder, dir) => {
    const res = await runSweep(sqlite3, recorder, dir, {
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

Deno.test(
  "PUBLIC API negative control: a lying no-op xSync is CAUGHT when the workload is driven through openDatabase",
  async () => {
    await withSweepVfs("crash-sweep-public-noopsync", false, async (sqlite3, recorder, dir) => {
      const res = await runSweep(sqlite3, recorder, dir, {
        spec: { txns: 4, rowsPerTxn: 2, dbName: "/publiclie.db" },
        seed: 424242,
        reconstructionsPerPoint: 6,
        dentryDurable: true,
        workloadDriver: PUBLIC_API_DRIVER,
        readbackDriver: PUBLIC_API_READBACK,
      });
      assert(
        res.failures.length > 0,
        `the public-API harness FAILED to catch a broken xSync — it proves nothing (recon=${res.reconstructions})`,
      );
      assert(
        res.failures.some((f) => f.detail.startsWith("I1")),
        "expected at least one integrity (I1) failure from unsynced corruption through the public API",
      );
    });
  },
);
