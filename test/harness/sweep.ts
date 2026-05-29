import type { Sqlite3 } from "../../src/glue.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import { isMutatingOp } from "./oplog.ts";
import type { Reconstruction } from "./reconstruct.ts";
import { reconstruct, RECONSTRUCTIONS } from "./reconstruct.ts";
import { createRng } from "./rng.ts";
import {
  committedValuesAt,
  type RecordedWorkload,
  runWorkload,
  type WorkloadSpec,
} from "./workload.ts";
import { verifyReconstruction } from "./verify.ts";

export interface SweepConfig {
  readonly spec: WorkloadSpec;
  readonly seed: number;
  readonly reconstructionsPerPoint: number;
  readonly dentryDurable: boolean;
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

export const runSweep = (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  dir: string,
  cfg: SweepConfig,
): SweepResult => {
  const recorded = runWorkload(sqlite3, recorder, cfg.spec);
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
      const result = verifyReconstruction(
        sqlite3,
        dir,
        recorded.dbName,
        image,
        committed,
        issued,
      );
      reconstructions++;
      if (!result.ok) {
        failures.push({ crashIndex: k, variant, seed: cfg.seed, subSeed, detail: result.detail });
      }
    }
  }

  return { crashPoints, reconstructions, failures, recorded };
};
