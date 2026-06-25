import { loadSqlite3 } from "../../src/glue.ts";
import type { Sqlite3 } from "../../src/glue.ts";
import { installCrashVfs } from "../harness/crash-vfs.ts";
import type { CrashRecorder } from "../harness/crash-vfs.ts";
import { runSweep } from "../harness/sweep.ts";
import type { SweepConfig, SweepFailure, SweepResult } from "../harness/sweep.ts";
import type { WorkloadDriver, WorkloadSpec } from "../harness/workload.ts";
import type { ReadbackDriver } from "../harness/verify.ts";

export const SWEEP_SEEDS = [1, 7, 1337, 90210, 2654435761] as const;

export const JOURNAL_MAGIC = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7] as const;

export const journalHasValidMagic = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 && JOURNAL_MAGIC.every((b, i) => bytes[i] === b);

export interface SweepEnv {
  readonly sqlite3: Sqlite3;
  readonly recorder: CrashRecorder;
  readonly dir: string;
}

export interface SweepVfsOptions {
  readonly vfsName: string;
  readonly realSync: boolean;
  readonly dirSync?: boolean;
  readonly tempPrefix?: string;
}

export const withSweepVfs = async <T>(
  opts: SweepVfsOptions,
  fn: (env: SweepEnv) => T | Promise<T>,
): Promise<T> => {
  const sqlite3 = await loadSqlite3();
  const recorder = opts.dirSync === undefined
    ? installCrashVfs(sqlite3, { vfsName: opts.vfsName, realSync: opts.realSync })
    : installCrashVfs(sqlite3, {
      vfsName: opts.vfsName,
      realSync: opts.realSync,
      dirSync: opts.dirSync,
    });
  const dir = await Deno.makeTempDir({ prefix: opts.tempPrefix ?? "crash-sweep-" });
  try {
    return await fn({ sqlite3, recorder, dir });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

export const fmtFailures = (failures: readonly SweepFailure[]): string =>
  failures
    .slice(0, 8)
    .map((f) => `k=${f.crashIndex} ${f.variant} subSeed=${f.subSeed}: ${f.detail}`)
    .join("\n");

export const integrityFailures = (failures: readonly SweepFailure[]): readonly SweepFailure[] =>
  failures.filter((f) => f.detail.startsWith("I1"));

export const commitLossFailures = (failures: readonly SweepFailure[]): readonly SweepFailure[] =>
  failures.filter((f) => f.detail.includes("lost committed"));

// I2: a committed marker vanished or an unissued value appeared; must hold under every
// reconstruction variant, torn-write scrambles included.
export const durabilityFailures = (failures: readonly SweepFailure[]): readonly SweepFailure[] =>
  failures.filter((f) => f.detail.startsWith("I2"));

export interface MatrixCell {
  readonly journalMode?: WorkloadSpec["journalMode"];
  readonly synchronous?: WorkloadSpec["synchronous"];
  readonly dirSync: boolean;
  readonly dentryDurable: boolean;
}

export interface MatrixSweepConfig {
  readonly cell: MatrixCell;
  readonly txns: number;
  readonly rowsPerTxn: number;
  readonly dbName: string;
  readonly seeds: readonly number[];
  readonly reconstructionsPerPoint: number;
  readonly realSync?: boolean;
  readonly workloadDriver?: WorkloadDriver;
  readonly readbackDriver?: ReadbackDriver;
  readonly vfsName?: string;
  /** When set, the marker workload mixes in the seeded hostile/UPDATE/DELETE/VACUUM op space. */
  readonly shapeSeed?: number;
}

export interface MatrixSweepResult {
  readonly bySeed: ReadonlyMap<number, SweepResult>;
  readonly failures: readonly SweepFailure[];
  readonly crashPoints: number;
  readonly reconstructions: number;
}

const cellLabel = (cell: MatrixCell): string =>
  `${cell.journalMode ?? "DELETE"}-${cell.synchronous ?? "default"}-dir${
    cell.dirSync ? 1 : 0
  }-dentry${cell.dentryDurable ? 1 : 0}`;

export const runMatrixSweep = async (
  cfg: MatrixSweepConfig,
): Promise<MatrixSweepResult> => {
  const label = cellLabel(cfg.cell);
  const bySeed = new Map<number, SweepResult>();
  const failures: SweepFailure[] = [];
  let crashPoints = 0;
  let reconstructions = 0;

  await withSweepVfs(
    {
      vfsName: cfg.vfsName ?? `matrix-${label}`,
      realSync: cfg.realSync ?? true,
      dirSync: cfg.cell.dirSync,
      tempPrefix: "matrix-sweep-",
    },
    async ({ sqlite3, recorder, dir }) => {
      for (const seed of cfg.seeds) {
        const spec: WorkloadSpec = {
          txns: cfg.txns,
          rowsPerTxn: cfg.rowsPerTxn,
          dbName: cfg.dbName,
          ...(cfg.cell.journalMode !== undefined ? { journalMode: cfg.cell.journalMode } : {}),
          ...(cfg.cell.synchronous !== undefined ? { synchronous: cfg.cell.synchronous } : {}),
          ...(cfg.shapeSeed !== undefined ? { shapeSeed: (cfg.shapeSeed ^ seed) >>> 0 } : {}),
        };
        const sweepCfg: SweepConfig = {
          spec,
          seed,
          reconstructionsPerPoint: cfg.reconstructionsPerPoint,
          dentryDurable: cfg.cell.dentryDurable,
          ...(cfg.workloadDriver !== undefined ? { workloadDriver: cfg.workloadDriver } : {}),
          ...(cfg.readbackDriver !== undefined ? { readbackDriver: cfg.readbackDriver } : {}),
        };
        const res = await runSweep(sqlite3, recorder, dir, sweepCfg);
        bySeed.set(seed, res);
        crashPoints += res.crashPoints;
        reconstructions += res.reconstructions;
        for (const f of res.failures) failures.push(f);
      }
    },
  );

  return { bySeed, failures, crashPoints, reconstructions };
};
