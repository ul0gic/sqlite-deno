import type { Sqlite3 } from "../../src/glue.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import { isMutatingOp } from "./oplog.ts";
import type { Reconstruction } from "./reconstruct.ts";
import { reconstruct, RECONSTRUCTIONS } from "./reconstruct.ts";
import { createRng } from "./rng.ts";
import type { FreeFormDriver, RecordedFreeForm } from "./freeform-workload.ts";
import { ENGINE_FREEFORM_DRIVER, runFreeFormWorkload } from "./freeform-workload.ts";
import type { FreeFormReadbackDriver } from "./freeform-verify.ts";
import { engineFreeFormReadback, verifyFreeForm } from "./freeform-verify.ts";
import type { FreeFormSpec } from "./freeform-workload.ts";

export interface FreeFormSweepConfig {
  readonly spec: FreeFormSpec;
  readonly seed: number;
  readonly reconstructionsPerPoint: number;
  readonly dentryDurable: boolean;
  readonly workloadDriver?: FreeFormDriver;
  readonly readbackDriver?: FreeFormReadbackDriver;
}

export interface FreeFormSweepFailure {
  readonly crashIndex: number;
  readonly variant: Reconstruction;
  readonly seed: number;
  readonly subSeed: number;
  readonly detail: string;
}

export interface FreeFormSweepResult {
  readonly crashPoints: number;
  readonly reconstructions: number;
  readonly failures: readonly FreeFormSweepFailure[];
  readonly recorded: RecordedFreeForm;
  readonly variantsSeen: ReadonlySet<Reconstruction>;
}

export const runFreeFormSweep = async (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  dir: string,
  cfg: FreeFormSweepConfig,
): Promise<FreeFormSweepResult> => {
  const workloadDriver = cfg.workloadDriver ?? ENGINE_FREEFORM_DRIVER;
  const readbackDriver = cfg.readbackDriver ?? engineFreeFormReadback(cfg.spec.mode);
  const recorded = runFreeFormWorkload(sqlite3, recorder, cfg.spec, workloadDriver);
  const failures: FreeFormSweepFailure[] = [];
  const variantsSeen = new Set<Reconstruction>();
  let reconstructions = 0;
  let crashPoints = 0;

  for (let k = 1; k <= recorded.ops.length; k++) {
    const op = recorded.ops[k - 1];
    if (op === undefined || !isMutatingOp(op)) continue;
    crashPoints++;
    for (let i = 0; i < cfg.reconstructionsPerPoint; i++) {
      const variant: Reconstruction = RECONSTRUCTIONS[i % RECONSTRUCTIONS.length] ??
        "scramble-arbitrary-sector";
      variantsSeen.add(variant);
      const subSeed = (cfg.seed * 1_000_003 + k * 131 + i) >>> 0;
      const rng = createRng(subSeed);
      const image = reconstruct(recorded.ops, k, variant, rng, {
        dentryDurable: cfg.dentryDurable,
      });
      const result = await verifyFreeForm(sqlite3, dir, recorded, image, k, readbackDriver);
      reconstructions++;
      if (!result.ok) {
        failures.push({ crashIndex: k, variant, seed: cfg.seed, subSeed, detail: result.detail });
      }
    }
  }

  return { crashPoints, reconstructions, failures, recorded, variantsSeen };
};

export const fmtFreeFormFailure = (
  recorded: RecordedFreeForm,
  f: FreeFormSweepFailure,
): string => {
  const ddl = recorded.schema.ddl.join("; ");
  const opsTrace = recorded.opLabels.join(" | ");
  return [
    `seed=${f.seed} subSeed=${f.subSeed} k=${f.crashIndex} variant=${f.variant} mode=${recorded.mode}/${recorded.durability}`,
    `  ${f.detail}`,
    `  schema: ${ddl}`,
    `  ops: ${opsTrace}`,
  ].join("\n");
};
