import { loadSqlite3, type Sqlite3 } from "../../src/glue.ts";
import { installCrashVfs } from "./crash-vfs.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import type { SchemaShape } from "./freeform-schema.ts";
import type { FreeFormSweepFailure } from "./freeform-sweep.ts";
import type { RecordedFreeForm } from "./freeform-workload.ts";
import { fmtFreeFormFailure } from "./freeform-sweep.ts";

const SOAK = Deno.env.get("SQLITE_DENO_SOAK") === "1";

const num = (name: string, fallback: number): number => {
  const raw = Deno.env.get(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export const SEEDS: readonly number[] = SOAK
  ? Array.from(
    { length: num("SQLITE_DENO_FREEFORM_SEEDS", 40) },
    (_, i) => (i * 2654435761 + 1) >>> 0,
  )
  : [1, 1337];

export const SHAPE: SchemaShape = SOAK
  ? {
    tables: num("SQLITE_DENO_FREEFORM_TABLES", 4),
    txns: num("SQLITE_DENO_FREEFORM_TXNS", 10),
    maxOpsPerTxn: 5,
    savepoints: true,
  }
  : { tables: 2, txns: 4, maxOpsPerTxn: 3, savepoints: true };

export const RECON_PER_POINT = SOAK ? 8 : 4;

export const withFreeFormVfs = async <T>(
  vfsName: string,
  realSync: boolean,
  fn: (sqlite3: Sqlite3, recorder: CrashRecorder, dir: string) => T | Promise<T>,
): Promise<T> => {
  const sqlite3 = await loadSqlite3();
  const recorder = installCrashVfs(sqlite3, { vfsName, realSync, dirSync: true });
  const dir = await Deno.makeTempDir({ prefix: "freeform-crash-" });
  try {
    return await fn(sqlite3, recorder, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

export const fmtFreeFormFailures = (
  recorded: RecordedFreeForm,
  failures: readonly FreeFormSweepFailure[],
): string => failures.slice(0, 5).map((f) => fmtFreeFormFailure(recorded, f)).join("\n\n");
