import type { Sqlite3 } from "../../src/glue.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import { isMutatingOp } from "./oplog.ts";
import type { Reconstruction } from "./reconstruct.ts";
import { reconstruct, RECONSTRUCTIONS } from "./reconstruct.ts";
import { createRng } from "./rng.ts";
import {
  committedValuesAt,
  ENGINE_DRIVER,
  type RecordedWorkload,
  runWorkload,
  type WorkloadDriver,
  type WorkloadSpec,
} from "./workload.ts";
import { ENGINE_READBACK, type ReadbackDriver, verifyReconstruction } from "./verify.ts";

export interface SweepConfig {
  readonly spec: WorkloadSpec;
  readonly seed: number;
  readonly reconstructionsPerPoint: number;
  readonly dentryDurable: boolean;
  /** How the workload is driven — engine floor (default) or the public surface. */
  readonly workloadDriver?: WorkloadDriver;
  /** How the post-crash image is reopened — engine floor (default) or the public surface. */
  readbackDriver?: ReadbackDriver;
}

export interface SweepFailure {
  readonly crashIndex: number;
  readonly variant: Reconstruction;
  readonly seed: number;
  readonly subSeed: number;
  readonly detail: string;
}

export interface SweepResult {
  readonly crashPoints: number;
  readonly reconstructions: number;
  readonly failures: readonly SweepFailure[];
  readonly recorded: RecordedWorkload;
}

const allIssuedValues = (recorded: RecordedWorkload): ReadonlySet<number> => {
  const issued = new Set<number>();
  for (const c of recorded.commits) issued.add(c.value);
  return issued;
};

export const runSweep = async (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  dir: string,
  cfg: SweepConfig,
): Promise<SweepResult> => {
  const workloadDriver = cfg.workloadDriver ?? ENGINE_DRIVER;
  const readbackDriver = cfg.readbackDriver ?? ENGINE_READBACK;
  const recorded = runWorkload(sqlite3, recorder, cfg.spec, workloadDriver);
  const issued = allIssuedValues(recorded);
  const failures: SweepFailure[] = [];
  let reconstructions = 0;
  let crashPoints = 0;

  for (let k = 1; k <= recorded.ops.length; k++) {
    const op = recorded.ops[k - 1];
    if (op === undefined || !isMutatingOp(op)) continue;
    crashPoints++;
    const committed = committedValuesAt(recorded.commits, k);
    for (let i = 0; i < cfg.reconstructionsPerPoint; i++) {
      const variant: Reconstruction = RECONSTRUCTIONS[i % RECONSTRUCTIONS.length] ??
        "scramble-arbitrary-sector";
      const subSeed = (cfg.seed * 1_000_003 + k * 131 + i) >>> 0;
      const rng = createRng(subSeed);
      const image = reconstruct(recorded.ops, k, variant, rng, {
        dentryDurable: cfg.dentryDurable,
      });
      const result = await verifyReconstruction(
        sqlite3,
        dir,
        recorded.dbName,
        image,
        committed,
        issued,
        readbackDriver,
      );
      reconstructions++;
      if (!result.ok) {
        failures.push({ crashIndex: k, variant, seed: cfg.seed, subSeed, detail: result.detail });
      }
    }
  }

  return { crashPoints, reconstructions, failures, recorded };
};
