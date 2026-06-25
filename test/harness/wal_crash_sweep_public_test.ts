import { assert, assertEquals } from "@std/assert";
import { runWalSweep } from "./wal-sweep.ts";
import { PUBLIC_API_WAL_DRIVER } from "./wal-workload.ts";
import { PUBLIC_API_WAL_READBACK } from "./wal-verify.ts";
import {
  fmtFailures,
  integrityFailures,
  lostCommittedFailures,
  RECON_PER_POINT,
  ROWS_PER_TXN,
  SEEDS,
  SHAPE_SEED,
  TXNS,
  withCrashVfs,
} from "./wal-sweep-fixtures.ts";

Deno.test(
  "PUBLIC API WAL sweep (mode=wal, durability=full): openDatabase keeps EVERY committed txn and stays corruption-free (I1+I2+I3) at every crash point — parity with the rollback FULL proof",
  async () => {
    await withCrashVfs("wal-sweep-public-full", true, async (sqlite3, recorder, dir) => {
      for (const seed of SEEDS) {
        const res = await runWalSweep(sqlite3, recorder, dir, {
          spec: {
            txns: TXNS,
            rowsPerTxn: ROWS_PER_TXN,
            dbName: "/wal-public-full.db",
            synchronous: "FULL",
          },
          seed,
          reconstructionsPerPoint: RECON_PER_POINT,
          workloadDriver: PUBLIC_API_WAL_DRIVER,
          readbackDriver: PUBLIC_API_WAL_READBACK,
        });
        assert(res.crashPoints > 20, `seed ${seed} swept too few crash points: ${res.crashPoints}`);
        assert(
          res.shmIrrelevantChecks > 0,
          `seed ${seed} never exercised the I3 stray-shm-irrelevant check through the public API`,
        );
        assertEquals(
          res.shmObserved,
          false,
          "I3: a public-API reconstruction materialized a -shm (Mode 2 never writes one through the seam)",
        );
        assertEquals(
          res.failures.length,
          0,
          `seed ${seed}: openDatabase(mode=wal, durability=full) produced ${res.failures.length} I1/I2/I3 failures across ${res.reconstructions} reconstructions — WAL recovery must be clean and lose no committed txn through the public path:\n${
            fmtFailures(res.failures)
          }`,
        );
      }
    });
  },
);

Deno.test(
  "PUBLIC API WAL sweep (mode=wal, durability=normal): integrity holds everywhere, the LAST committed txn can still be absent (the documented ENH-003 weaker opt-in)",
  async () => {
    await withCrashVfs("wal-sweep-public-normal", true, async (sqlite3, recorder, dir) => {
      for (const seed of SEEDS) {
        const res = await runWalSweep(sqlite3, recorder, dir, {
          spec: {
            txns: TXNS,
            rowsPerTxn: ROWS_PER_TXN,
            dbName: "/wal-public-normal.db",
            synchronous: "NORMAL",
          },
          seed,
          reconstructionsPerPoint: RECON_PER_POINT,
          workloadDriver: PUBLIC_API_WAL_DRIVER,
          readbackDriver: PUBLIC_API_WAL_READBACK,
        });
        assertEquals(res.shmObserved, false, "I3: public-API NORMAL run materialized a -shm");
        assertEquals(
          integrityFailures(res.failures).length,
          0,
          `seed ${seed}: durability=normal must still be consistency-safe (no CORRUPT/I1 database) through the public WAL path:\n${
            fmtFailures(integrityFailures(res.failures))
          }`,
        );
        assertEquals(
          lostCommittedFailures(res.failures).length,
          0,
          `seed ${seed}: a DURABLE-required commit was lost at NORMAL through the public WAL path (the verifier only requires -wal-sync-covered commits present, so this is a real I2 violation):\n${
            fmtFailures(lostCommittedFailures(res.failures))
          }`,
        );
      }
    });
  },
);

Deno.test(
  "PUBLIC API WAL sweep (mode=wal, durability=full), SHAPED workload (hostile aux rows, UPDATE/DELETE in-txn, VACUUM between txns): openDatabase keeps EVERY committed kv marker and stays corruption-free (I1+I2+I3) at every crash point",
  async () => {
    await withCrashVfs("wal-sweep-public-full-shaped", true, async (sqlite3, recorder, dir) => {
      for (const seed of SEEDS) {
        const res = await runWalSweep(sqlite3, recorder, dir, {
          spec: {
            txns: TXNS,
            rowsPerTxn: ROWS_PER_TXN,
            dbName: "/wal-public-full-shaped.db",
            synchronous: "FULL",
            shapeSeed: (SHAPE_SEED ^ seed) >>> 0,
          },
          seed,
          reconstructionsPerPoint: RECON_PER_POINT,
          workloadDriver: PUBLIC_API_WAL_DRIVER,
          readbackDriver: PUBLIC_API_WAL_READBACK,
        });
        assert(res.crashPoints > 20, `seed ${seed} swept too few crash points: ${res.crashPoints}`);
        assertEquals(
          res.shmObserved,
          false,
          "I3: a shaped public-API reconstruction materialized a -shm (VACUUM-in-WAL must not create one through the seam)",
        );
        assertEquals(
          res.failures.length,
          0,
          `seed ${seed}: openDatabase(mode=wal, durability=full) with the shaped workload produced ${res.failures.length} I1/I2/I3 failures across ${res.reconstructions} reconstructions — VACUUM/UPDATE/DELETE around the kv markers must lose no committed marker and stay corruption-free through the public path:\n${
            fmtFailures(res.failures)
          }`,
        );
      }
    });
  },
);

Deno.test(
  "PUBLIC API WAL sweep (mode=wal, durability=normal), SHAPED workload: integrity holds over VACUUM/UPDATE/DELETE, the LAST committed txn can still be absent (the documented ENH-003 weaker opt-in)",
  async () => {
    await withCrashVfs("wal-sweep-public-normal-shaped", true, async (sqlite3, recorder, dir) => {
      for (const seed of SEEDS) {
        const res = await runWalSweep(sqlite3, recorder, dir, {
          spec: {
            txns: TXNS,
            rowsPerTxn: ROWS_PER_TXN,
            dbName: "/wal-public-normal-shaped.db",
            synchronous: "NORMAL",
            shapeSeed: (SHAPE_SEED ^ seed) >>> 0,
          },
          seed,
          reconstructionsPerPoint: RECON_PER_POINT,
          workloadDriver: PUBLIC_API_WAL_DRIVER,
          readbackDriver: PUBLIC_API_WAL_READBACK,
        });
        assertEquals(
          res.shmObserved,
          false,
          "I3: shaped public-API NORMAL run materialized a -shm",
        );
        assertEquals(
          integrityFailures(res.failures).length,
          0,
          `seed ${seed}: durability=normal must stay consistency-safe (no CORRUPT/I1 database) over the shaped workload through the public WAL path:\n${
            fmtFailures(integrityFailures(res.failures))
          }`,
        );
        assertEquals(
          lostCommittedFailures(res.failures).length,
          0,
          `seed ${seed}: a DURABLE-required commit was lost at NORMAL with the shaped workload through the public WAL path:\n${
            fmtFailures(lostCommittedFailures(res.failures))
          }`,
        );
      }
    });
  },
);

Deno.test(
  "PUBLIC API WAL negative control: a lying no-op xSync drops the -wal commit frame and is CAUGHT when the workload is driven through openDatabase",
  async () => {
    await withCrashVfs("wal-sweep-public-noopsync", false, async (sqlite3, recorder, dir) => {
      const res = await runWalSweep(sqlite3, recorder, dir, {
        spec: { txns: 4, rowsPerTxn: 2, dbName: "/wal-public-lie.db", synchronous: "FULL" },
        seed: 0xbad5,
        reconstructionsPerPoint: 8,
        workloadDriver: PUBLIC_API_WAL_DRIVER,
        readbackDriver: PUBLIC_API_WAL_READBACK,
      });
      assert(
        res.failures.length > 0,
        `the public-API WAL harness FAILED to catch a lying xSync — it cannot detect WAL corruption, so it proves nothing (recon=${res.reconstructions})`,
      );
      assert(
        res.failures.some((f) => f.detail.startsWith("I2")),
        `expected a lost-committed (I2) failure from the dropped -wal commit frame through the public API; got:\n${
          fmtFailures(res.failures)
        }`,
      );
    });
  },
);
