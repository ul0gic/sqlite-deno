import { assert, assertEquals } from "@std/assert";
import { generateWorkload } from "./freeform-schema.ts";
import {
  ENGINE_FREEFORM_DRIVER,
  type FreeFormSpec,
  PUBLIC_FREEFORM_DRIVER,
  runFreeFormWorkload,
} from "./freeform-workload.ts";
import { engineFreeFormReadback, publicFreeFormReadback } from "./freeform-verify.ts";
import { runFreeFormSweep } from "./freeform-sweep.ts";
import {
  acceptableStatesAt,
  committedStateAt,
  type DbState,
  type Row,
  stateMismatch,
} from "./freeform-model.ts";
import {
  fmtFreeFormFailures,
  RECON_PER_POINT,
  SEEDS,
  SHAPE,
  withFreeFormVfs,
} from "./freeform-sweep-fixtures.ts";

type Mode = FreeFormSpec["mode"];
type Durability = FreeFormSpec["durability"];

const sweepCase = (
  name: string,
  mode: Mode,
  durability: Durability,
  driver: "engine" | "public",
): void => {
  Deno.test(
    `FREE-FORM crash sweep [${name}]: generated multi-table schema is the I2 witness — exact committed-state equality (loss/phantom/resurrection) + integrity at every crash point and reconstruction variant`,
    async () => {
      await withFreeFormVfs(`freeform-${name}`, true, async (sqlite3, recorder, dir) => {
        let scrambleReached = false;
        for (const seed of SEEDS) {
          const workload = generateWorkload(seed, SHAPE);
          const res = await runFreeFormSweep(sqlite3, recorder, dir, {
            spec: { workload, dbName: `/ff-${name}.db`, mode, durability },
            seed,
            reconstructionsPerPoint: RECON_PER_POINT,
            dentryDurable: true,
            workloadDriver: driver === "engine" ? ENGINE_FREEFORM_DRIVER : PUBLIC_FREEFORM_DRIVER,
            readbackDriver: driver === "engine"
              ? engineFreeFormReadback(mode)
              : publicFreeFormReadback(mode),
          });
          assert(
            res.crashPoints > 20,
            `seed ${seed} swept too few crash points: ${res.crashPoints}`,
          );
          if (
            res.variantsSeen.has("scramble-tail") &&
            res.variantsSeen.has("scramble-arbitrary-sector")
          ) scrambleReached = true;
          assertEquals(
            res.failures.length,
            0,
            `seed ${seed} [${name}]: ${res.failures.length} I1/I2 violations across ${res.reconstructions} reconstructions of the generated workload:\n${
              fmtFreeFormFailures(res.recorded, res.failures)
            }`,
          );
        }
        assert(scrambleReached, `[${name}] never reached the torn-write scramble variants`);
      });
    },
  );
};

sweepCase("rollback-full-engine", "rollback", "full", "engine");
sweepCase("rollback-full-public", "rollback", "full", "public");
sweepCase("wal-full-engine", "wal", "full", "engine");
sweepCase("wal-full-public", "wal", "full", "public");
sweepCase("wal-normal-engine", "wal", "normal", "engine");
sweepCase("wal-normal-public", "wal", "normal", "public");

Deno.test(
  "FREE-FORM negative control: a lying no-op xSync drops committed rows and is CAUGHT (the generalized oracle detects loss/corruption — without this it proves nothing)",
  async () => {
    await withFreeFormVfs("freeform-lying", false, async (sqlite3, recorder, dir) => {
      let caught = 0;
      let recon = 0;
      for (const seed of [1, 7, 1337]) {
        const workload = generateWorkload(seed, { ...SHAPE, txns: 6 });
        const res = await runFreeFormSweep(sqlite3, recorder, dir, {
          spec: { workload, dbName: "/ff-lie.db", mode: "rollback", durability: "full" },
          seed,
          reconstructionsPerPoint: 4,
          dentryDurable: true,
          readbackDriver: engineFreeFormReadback("rollback"),
        });
        caught += res.failures.length;
        recon += res.reconstructions;
      }
      assert(
        caught > 0,
        `the free-form harness FAILED to catch a lying xSync over ${recon} reconstructions — it cannot detect loss, so it proves nothing`,
      );
    });
  },
);

const cloneState = (s: DbState): Map<string, Map<number, Row>> => {
  const out = new Map<string, Map<number, Row>>();
  for (const [name, t] of s) out.set(name, new Map(t));
  return out;
};

Deno.test(
  "FREE-FORM oracle teeth: an injected resurrection (a deleted-committed row planted back) and a dropped committed row are both CAUGHT by exact-equality — the {prior,next} band did not blunt the guards",
  async () => {
    await withFreeFormVfs("freeform-teeth", true, (sqlite3, recorder) => {
      const workload = generateWorkload(7, { ...SHAPE, txns: 6 });
      const recorded = runFreeFormWorkload(sqlite3, recorder, {
        workload,
        dbName: "/ff-teeth.db",
        mode: "rollback",
        durability: "full",
      }, ENGINE_FREEFORM_DRIVER);
      const k = recorded.ops.length;
      const expected = committedStateAt(recorded.snapshots, k);
      const candidates = acceptableStatesAt(recorded.snapshots, k, true);
      const table = [...expected.keys()][0];
      assert(table !== undefined, "generated workload produced no tables");

      const honest = cloneState(expected);
      assert(
        candidates.some((c) => stateMismatch(c, honest) === null),
        "control: the honest final committed state must be accepted",
      );

      const resurrected = cloneState(expected);
      resurrected.get(table)?.set(999999, [null]);
      assert(
        candidates.every((c) => stateMismatch(c, resurrected) !== null),
        "a planted phantom row was NOT caught — the resurrection guard is blunted",
      );

      const realId = [...(expected.get(table)?.keys() ?? [])][0];
      if (realId !== undefined) {
        const dropped = cloneState(expected);
        dropped.get(table)?.delete(realId);
        assert(
          candidates.every((c) => stateMismatch(c, dropped) !== null),
          `dropping committed row id=${realId} was NOT caught — the loss guard is blunted`,
        );
      }
    });
  },
);
