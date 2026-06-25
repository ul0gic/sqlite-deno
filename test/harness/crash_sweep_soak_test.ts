import { assert, assertEquals } from "@std/assert";
import { PUBLIC_API_DRIVER } from "./workload.ts";
import { PUBLIC_API_READBACK } from "./verify.ts";
import {
  durabilityFailures,
  fmtFailures,
  integrityFailures,
  type MatrixCell,
  runMatrixSweep,
  SWEEP_SEEDS,
} from "../fixtures/crash_sweep_harness.ts";

const SOAK = Deno.env.get("SQLITE_DENO_SOAK") === "1";
const SOAK_TXNS = Number(Deno.env.get("SQLITE_DENO_SOAK_CRASH_TXNS") ?? "8");
const SOAK_ROWS = Number(Deno.env.get("SQLITE_DENO_SOAK_CRASH_ROWS") ?? "4");
const SOAK_RECON = Number(Deno.env.get("SQLITE_DENO_SOAK_CRASH_RECON") ?? "10");

const CI_SEEDS = [1, 7] as const;
const SOAK_SEEDS = [...SWEEP_SEEDS, 0xdead, 0xbeef, 0xc0ffee, 123456789] as const;

const seeds = (): readonly number[] => (SOAK ? SOAK_SEEDS : CI_SEEDS);
const txns = (): number => (SOAK ? SOAK_TXNS : 3);
const rows = (): number => (SOAK ? SOAK_ROWS : 2);
const recon = (): number => (SOAK ? SOAK_RECON : 2);

const PROPERTY_SHAPE_SEED = 0x5ca1ab1e;

interface MatrixEntry {
  readonly name: string;
  readonly cell: MatrixCell;
}

const PROPERTY_MATRIX: readonly MatrixEntry[] = [
  {
    name: "DELETE/FULL/dir0/dentry1",
    cell: { journalMode: "DELETE", synchronous: "FULL", dirSync: false, dentryDurable: true },
  },
  {
    name: "PERSIST/FULL/dir0/dentry0",
    cell: { journalMode: "PERSIST", synchronous: "FULL", dirSync: false, dentryDurable: false },
  },
  {
    name: "TRUNCATE/FULL/dir0/dentry0",
    cell: { journalMode: "TRUNCATE", synchronous: "FULL", dirSync: false, dentryDurable: false },
  },
  {
    name: "DELETE/EXTRA/dir1/dentry0",
    cell: { journalMode: "DELETE", synchronous: "EXTRA", dirSync: true, dentryDurable: false },
  },
];

const slug = (name: string): string => name.replaceAll("/", "-");

for (const entry of PROPERTY_MATRIX) {
  Deno.test({
    name:
      `rollback crash soak [${entry.name}]: property workload (hostile rows, UPDATE/DELETE/VACUUM) loses zero committed markers and holds integrity at every crash point and reconstruction variant`,
    fn: async () => {
      const res = await runMatrixSweep({
        cell: entry.cell,
        txns: txns(),
        rowsPerTxn: rows(),
        dbName: `/soak-${slug(entry.name)}.db`,
        seeds: seeds(),
        reconstructionsPerPoint: recon(),
        shapeSeed: PROPERTY_SHAPE_SEED,
        vfsName: `crash-soak-${slug(entry.name)}`,
      });
      assert(res.crashPoints > 20, `${entry.name} swept too few crash points: ${res.crashPoints}`);
      assertEquals(
        durabilityFailures(res.failures).length,
        0,
        `${entry.name} violated durability (lost a committed marker or resurrected an uncommitted value) across ${res.reconstructions} reconstructions of the property workload:\n${
          fmtFailures(durabilityFailures(res.failures))
        }`,
      );
      assertEquals(
        integrityFailures(res.failures).length,
        0,
        `${entry.name} corrupted (I1) at a reconstruction of the property workload:\n${
          fmtFailures(integrityFailures(res.failures))
        }`,
      );
    },
  });
}

Deno.test({
  name:
    "rollback crash soak [BUG-001 standing proof]: DELETE+EXTRA+dir-sync with ZERO directory durability AND the property workload still loses zero committed markers and holds integrity at every variant",
  fn: async () => {
    const res = await runMatrixSweep({
      cell: { journalMode: "DELETE", synchronous: "EXTRA", dirSync: true, dentryDurable: false },
      txns: txns(),
      rowsPerTxn: rows(),
      dbName: "/soak-bug001-standing.db",
      seeds: seeds(),
      reconstructionsPerPoint: recon(),
      shapeSeed: PROPERTY_SHAPE_SEED ^ 0x1111,
      vfsName: "crash-soak-bug001-standing",
    });
    assertEquals(
      durabilityFailures(res.failures).length,
      0,
      `BUG-001 commit-point fix regressed under the property workload — DELETE+EXTRA+dir-sync lost or phantomed a committed marker across ${res.reconstructions} reconstructions:\n${
        fmtFailures(durabilityFailures(res.failures))
      }`,
    );
    assertEquals(
      integrityFailures(res.failures).length,
      0,
      `BUG-001 standing proof corrupted (I1) under the property workload:\n${
        fmtFailures(integrityFailures(res.failures))
      }`,
    );
  },
});

Deno.test({
  name:
    "rollback crash soak [public surface]: openDatabase default (durability=full) over the property workload loses zero committed markers and holds integrity at every variant",
  fn: async () => {
    const res = await runMatrixSweep({
      cell: { dirSync: false, dentryDurable: true },
      txns: txns(),
      rowsPerTxn: rows(),
      dbName: "/soak-public.db",
      seeds: seeds(),
      reconstructionsPerPoint: recon(),
      shapeSeed: PROPERTY_SHAPE_SEED ^ 0x2222,
      workloadDriver: PUBLIC_API_DRIVER,
      readbackDriver: PUBLIC_API_READBACK,
      vfsName: "crash-soak-public",
    });
    assertEquals(
      integrityFailures(res.failures).length,
      0,
      `the shipped public surface corrupted (I1) under the property workload:\n${
        fmtFailures(integrityFailures(res.failures))
      }`,
    );
    assertEquals(
      durabilityFailures(res.failures).length,
      0,
      `the durable default (durability=full) lost or phantomed a committed marker under the property workload:\n${
        fmtFailures(durabilityFailures(res.failures))
      }`,
    );
  },
});

Deno.test({
  name:
    "rollback crash soak negative control: a lying no-op xSync over the property workload is STILL CAUGHT (the soak harness has teeth)",
  fn: async () => {
    const res = await runMatrixSweep({
      cell: { journalMode: "DELETE", dirSync: false, dentryDurable: false },
      txns: 4,
      rowsPerTxn: 2,
      dbName: "/soak-lie.db",
      seeds: [424242],
      reconstructionsPerPoint: 6,
      realSync: false,
      shapeSeed: PROPERTY_SHAPE_SEED ^ 0x3333,
      vfsName: "crash-soak-noopsync",
    });
    assert(
      integrityFailures(res.failures).length > 0,
      "the property-workload soak harness FAILED to catch a broken xSync — it proves nothing",
    );
  },
});
