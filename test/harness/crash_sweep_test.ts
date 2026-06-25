import { assert, assertEquals } from "@std/assert";
import { PUBLIC_API_DRIVER, PUBLIC_API_NORMAL_DRIVER } from "./workload.ts";
import { PUBLIC_API_READBACK } from "./verify.ts";
import {
  commitLossFailures,
  durabilityFailures,
  fmtFailures,
  integrityFailures,
  runMatrixSweep,
  SWEEP_SEEDS,
} from "../fixtures/crash_sweep_harness.ts";

Deno.test("content power-loss sweep: every crash point keeps committed txns and integrity", async () => {
  const res = await runMatrixSweep({
    cell: { dirSync: false, dentryDurable: true },
    txns: 5,
    rowsPerTxn: 2,
    dbName: "/sweep.db",
    seeds: SWEEP_SEEDS,
    reconstructionsPerPoint: 6,
    vfsName: "crash-sweep-content",
  });
  assert(res.crashPoints > 20, `swept too few crash points: ${res.crashPoints}`);
  assertEquals(
    res.failures.length,
    0,
    `produced ${res.failures.length} I1/I2 failures across ${res.reconstructions} reconstructions:\n${
      fmtFailures(res.failures)
    }`,
  );
});

Deno.test("content power-loss sweep survives a write-heavy multi-row workload", async () => {
  const res = await runMatrixSweep({
    cell: { dirSync: false, dentryDurable: true },
    txns: 3,
    rowsPerTxn: 8,
    dbName: "/heavy.db",
    seeds: [0x5eed],
    reconstructionsPerPoint: 8,
    vfsName: "crash-sweep-heavy",
  });
  assertEquals(
    res.failures.length,
    0,
    `produced failures:\n${fmtFailures(res.failures)}`,
  );
});

Deno.test(
  "PUBLIC API power-loss sweep (shipped default, durability=full): openDatabase keeps EVERY committed txn and stays corruption-free at every crash point",
  async () => {
    const res = await runMatrixSweep({
      cell: { dirSync: false, dentryDurable: true },
      txns: 5,
      rowsPerTxn: 2,
      dbName: "/public.db",
      seeds: SWEEP_SEEDS,
      reconstructionsPerPoint: 6,
      workloadDriver: PUBLIC_API_DRIVER,
      readbackDriver: PUBLIC_API_READBACK,
      vfsName: "crash-sweep-public",
    });
    assert(res.crashPoints > 20, `swept too few crash points: ${res.crashPoints}`);
    assertEquals(
      integrityFailures(res.failures).length,
      0,
      `openDatabase reopen produced a CORRUPT (I1) database through the public API across ${res.reconstructions} reconstructions — integrity must hold at every crash point:\n${
        fmtFailures(integrityFailures(res.failures))
      }`,
    );
    assertEquals(
      commitLossFailures(res.failures).length,
      0,
      `the durable default (durability=full) LOST a committed txn through the public API across ${res.reconstructions} reconstructions — BUG-004 regressed (default reverted to synchronous=NORMAL?):\n${
        fmtFailures(commitLossFailures(res.failures))
      }`,
    );
  },
);

Deno.test(
  "PUBLIC API power-loss sweep (explicit durability=normal): integrity holds everywhere, but the LAST committed txn can still be lost (the documented weaker opt-in)",
  async () => {
    const res = await runMatrixSweep({
      cell: { dirSync: false, dentryDurable: true },
      txns: 5,
      rowsPerTxn: 2,
      dbName: "/publicnormal.db",
      seeds: SWEEP_SEEDS,
      reconstructionsPerPoint: 6,
      workloadDriver: PUBLIC_API_NORMAL_DRIVER,
      readbackDriver: PUBLIC_API_READBACK,
      vfsName: "crash-sweep-public-normal",
    });
    assertEquals(
      integrityFailures(res.failures).length,
      0,
      `durability=normal must still be consistency-safe (no CORRUPT/I1 database) through the public API:\n${
        fmtFailures(integrityFailures(res.failures))
      }`,
    );
    assert(
      commitLossFailures(res.failures).length > 0,
      "durability=normal stopped losing a committed txn through the public API — the FULL-vs-NORMAL durability distinction is no longer demonstrated; do not silently relax this.",
    );
  },
);

Deno.test(
  "PUBLIC API sweep: a transaction-heavy workload (prepare/run + savepoint transaction) stays corruption-free (I1) at every crash point",
  async () => {
    const res = await runMatrixSweep({
      cell: { dirSync: false, dentryDurable: true },
      txns: 3,
      rowsPerTxn: 8,
      dbName: "/publicheavy.db",
      seeds: [0x9a11],
      reconstructionsPerPoint: 8,
      workloadDriver: PUBLIC_API_DRIVER,
      readbackDriver: PUBLIC_API_READBACK,
      vfsName: "crash-sweep-public-heavy",
    });
    assertEquals(
      integrityFailures(res.failures).length,
      0,
      `the public prepare/run + savepoint path produced a CORRUPT (I1) database:\n${
        fmtFailures(integrityFailures(res.failures))
      }`,
    );
  },
);

Deno.test(
  "torn-write standing proof: a VACUUM post-commit truncate + a scramble reconstruction never corrupts an already-synced committed page (the truncate rewrites no retained byte)",
  async () => {
    const res = await runMatrixSweep({
      cell: { journalMode: "DELETE", synchronous: "EXTRA", dirSync: true, dentryDurable: false },
      txns: 6,
      rowsPerTxn: 3,
      dbName: "/torn-truncate.db",
      seeds: [18],
      reconstructionsPerPoint: 6,
      shapeSeed: 0x5ca1ab1e,
      vfsName: "crash-sweep-torn-truncate",
    });
    assert(res.crashPoints > 20, `swept too few crash points: ${res.crashPoints}`);
    assertEquals(
      integrityFailures(res.failures).length,
      0,
      `a torn-write scramble corrupted a synced committed page (I1) — the truncate boundary-sector faithfulness fix regressed across ${res.reconstructions} reconstructions:\n${
        fmtFailures(integrityFailures(res.failures))
      }`,
    );
    assertEquals(
      durabilityFailures(res.failures).length,
      0,
      `the VACUUM-bearing property workload lost or phantomed a committed marker (I2):\n${
        fmtFailures(durabilityFailures(res.failures))
      }`,
    );
  },
);

Deno.test("negative control: a lying no-op xSync is CAUGHT by the harness", async () => {
  const res = await runMatrixSweep({
    cell: { dirSync: false, dentryDurable: true },
    txns: 4,
    rowsPerTxn: 2,
    dbName: "/lie.db",
    seeds: [424242],
    reconstructionsPerPoint: 6,
    realSync: false,
    vfsName: "crash-sweep-noopsync",
  });
  assert(
    res.failures.length > 0,
    `harness FAILED to catch a broken xSync — it cannot detect corruption, so it proves nothing (recon=${res.reconstructions})`,
  );
  assert(
    integrityFailures(res.failures).length > 0,
    "expected at least one integrity (I1) failure from unsynced corruption",
  );
});

Deno.test(
  "PUBLIC API negative control: a lying no-op xSync is CAUGHT when the workload is driven through openDatabase",
  async () => {
    const res = await runMatrixSweep({
      cell: { dirSync: false, dentryDurable: true },
      txns: 4,
      rowsPerTxn: 2,
      dbName: "/publiclie.db",
      seeds: [424242],
      reconstructionsPerPoint: 6,
      realSync: false,
      workloadDriver: PUBLIC_API_DRIVER,
      readbackDriver: PUBLIC_API_READBACK,
      vfsName: "crash-sweep-public-noopsync",
    });
    assert(
      res.failures.length > 0,
      `the public-API harness FAILED to catch a broken xSync — it proves nothing (recon=${res.reconstructions})`,
    );
    assert(
      integrityFailures(res.failures).length > 0,
      "expected at least one integrity (I1) failure from unsynced corruption through the public API",
    );
  },
);
