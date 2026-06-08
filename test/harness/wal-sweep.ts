import type { Sqlite3 } from "../../src/glue.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import { isMutatingOp } from "./oplog.ts";
import { createRng } from "./rng.ts";
import {
  committedSetsAt,
  ENGINE_WAL_DRIVER,
  type RecordedWalWorkload,
  runWalWorkload,
  type WalWorkloadDriver,
  type WalWorkloadSpec,
} from "./wal-workload.ts";
import { reconstructWal, WAL_VARIANTS } from "./wal-reconstruct.ts";
import {
  ENGINE_WAL_READBACK,
  verifyWalReconstruction,
  type WalReadbackDriver,
} from "./wal-verify.ts";

export interface WalSweepConfig {
  readonly spec: WalWorkloadSpec;
  readonly seed: number;
  readonly reconstructionsPerPoint: number;
  /** How the workload is driven — engine floor (default) or the public surface. */
  readonly workloadDriver?: WalWorkloadDriver;
  /** How the post-crash image is reopened — engine floor (default) or the public surface. */
  readonly readbackDriver?: WalReadbackDriver;
}

export interface WalSweepFailure {
  readonly crashIndex: number;
  readonly content: string;
  readonly tail: string;
  readonly seed: number;
  readonly subSeed: number;
  readonly detail: string;
}

export interface WalSweepResult {
  readonly crashPoints: number;
  readonly reconstructions: number;
  readonly shmObserved: boolean;
  readonly shmIrrelevantChecks: number;
  readonly failures: readonly WalSweepFailure[];
  readonly recorded: RecordedWalWorkload;
}

export const runWalSweep = async (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  dir: string,
  cfg: WalSweepConfig,
): Promise<WalSweepResult> => {
  const workloadDriver = cfg.workloadDriver ?? ENGINE_WAL_DRIVER;
  const readbackDriver = cfg.readbackDriver ?? ENGINE_WAL_READBACK;
  const recorded = runWalWorkload(sqlite3, recorder, cfg.spec, workloadDriver);
  const failures: WalSweepFailure[] = [];
  let reconstructions = 0;
  let crashPoints = 0;
  let shmObserved = false;
  let shmIrrelevantChecks = 0;

  for (let k = 1; k <= recorded.ops.length; k++) {
    const op = recorded.ops[k - 1];
    if (op === undefined || !isMutatingOp(op)) continue;
    crashPoints++;
    const sets = committedSetsAt(recorded, k);
    for (let i = 0; i < cfg.reconstructionsPerPoint; i++) {
      const variant = WAL_VARIANTS[i % WAL_VARIANTS.length];
      if (variant === undefined) continue;
      const subSeed = (cfg.seed * 1_000_003 + k * 131 + i) >>> 0;
      const rng = createRng(subSeed);
      const { image, hasShm } = reconstructWal(recorded.ops, k, variant.content, variant.tail, rng);
      if (hasShm) shmObserved = true;
      const assertShmIrrelevant = i % 3 === 0;
      if (assertShmIrrelevant) shmIrrelevantChecks++;
      const result = await verifyWalReconstruction(sqlite3, dir, recorded.dbName, image, sets, {
        assertShmIrrelevant,
        readbackDriver,
      });
      reconstructions++;
      if (!result.ok) {
        failures.push({
          crashIndex: k,
          content: variant.content,
          tail: variant.tail,
          seed: cfg.seed,
          subSeed,
          detail: result.detail,
        });
      }
    }
  }

  return {
    crashPoints,
    reconstructions,
    shmObserved,
    shmIrrelevantChecks,
    failures,
    recorded,
  };
};
