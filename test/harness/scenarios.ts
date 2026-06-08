import type { Sqlite3 } from "../../src/glue.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import type { Op } from "./oplog.ts";
import { reconstruct, RECONSTRUCTIONS } from "./reconstruct.ts";
import { createRng } from "./rng.ts";
import {
  committedValuesAt,
  type RecordedWorkload,
  runWorkload,
  type WorkloadSpec,
} from "./workload.ts";
import { verifyReconstruction } from "./verify.ts";

const isJournal = (file: string): boolean => file.endsWith("-journal");
const opAt = (ops: readonly Op[], k: number): Op | undefined => ops[k - 1];

export const journalDeleteIndices = (recorded: RecordedWorkload): readonly number[] => {
  const out: number[] = [];
  recorded.ops.forEach((op, i) => {
    if (op.kind === "delete" && isJournal(op.file)) out.push(i + 1);
  });
  return out;
};

export const journalCreateMidUpdateIndices = (recorded: RecordedWorkload): readonly number[] => {
  const out: number[] = [];
  for (let k = 1; k <= recorded.ops.length; k++) {
    const op = opAt(recorded.ops, k);
    if (op?.kind === "write" && !isJournal(op.file)) {
      const prev = opAt(recorded.ops, k - 1);
      if (prev && (prev.kind === "sync" || prev.kind === "write") && !isJournal(prev.file)) {
        continue;
      }
      out.push(k);
    }
  }
  return out;
};

export interface ScenarioRun {
  readonly crashIndex: number;
  readonly seed: number;
  readonly committedLostAt: number | null;
  readonly integrityFailed: boolean;
  readonly detail: string;
}

export interface ScenarioSummary {
  readonly runs: number;
  readonly failures: readonly ScenarioRun[];
}

interface ScenarioConfig {
  readonly spec: WorkloadSpec;
  readonly seeds: readonly number[];
  readonly indices: (recorded: RecordedWorkload) => readonly number[];
}

const allIssued = (recorded: RecordedWorkload): ReadonlySet<number> => {
  const issued = new Set<number>();
  for (const c of recorded.commits) issued.add(c.value);
  return issued;
};

export const runDentryScenario = async (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  dir: string,
  cfg: ScenarioConfig,
): Promise<ScenarioSummary> => {
  const recorded = runWorkload(sqlite3, recorder, cfg.spec);
  const issued = allIssued(recorded);
  const indices = cfg.indices(recorded);
  const failures: ScenarioRun[] = [];
  let runs = 0;

  for (const k of indices) {
    const committed = committedValuesAt(recorded.commits, k);
    for (const seed of cfg.seeds) {
      for (const variant of RECONSTRUCTIONS) {
        const subSeed = (seed * 1_000_003 + k * 131) >>> 0;
        const rng = createRng(subSeed);
        const image = reconstruct(recorded.ops, k, variant, rng, { dentryDurable: false });
        const result = await verifyReconstruction(
          sqlite3,
          dir,
          recorded.dbName,
          image,
          committed,
          issued,
        );
        runs++;
        if (!result.ok) {
          const integrityFailed = result.detail.startsWith("I1");
          const lost = [...committed].find((v) => !result.present.has(v)) ?? null;
          failures.push({
            crashIndex: k,
            seed,
            committedLostAt: lost,
            integrityFailed,
            detail: result.detail,
          });
        }
      }
    }
  }

  return { runs, failures };
};
