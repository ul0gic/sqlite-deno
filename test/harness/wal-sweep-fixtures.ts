import { loadSqlite3, type Sqlite3 } from "../../src/glue.ts";
import { installCrashVfs } from "./crash-vfs.ts";
import { WAL_VARIANTS } from "./wal-reconstruct.ts";
import type { WalSweepFailure } from "./wal-sweep.ts";

const SOAK = Deno.env.get("SQLITE_DENO_SOAK") === "1";

export const SEEDS = SOAK
  ? [1, 7, 1337, 90210, 2654435761, 0x5eed, 0xc0ffee, 0xdecafbad, 42, 86753]
  : [1, 7, 1337];
export const TXNS = SOAK ? 8 : 4;
export const ROWS_PER_TXN = SOAK ? 4 : 2;
export const RECON_PER_POINT = SOAK ? 8 : WAL_VARIANTS.length;
export const CKPT_RECON = SOAK ? 8 : 6;
export const SHAPE_SEED = 0x5ca1ab1e;

export const withCrashVfs = async <T>(
  vfsName: string,
  realSync: boolean,
  fn: (
    sqlite3: Sqlite3,
    recorder: ReturnType<typeof installCrashVfs>,
    dir: string,
  ) => T | Promise<T>,
): Promise<T> => {
  const sqlite3 = await loadSqlite3();
  const recorder = installCrashVfs(sqlite3, { vfsName, realSync, dirSync: true });
  const dir = await Deno.makeTempDir({ prefix: "wal-crash-sweep-" });
  try {
    return await fn(sqlite3, recorder, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

export const fmtFailures = (failures: readonly WalSweepFailure[]): string =>
  failures
    .slice(0, 10)
    .map((f) => `k=${f.crashIndex} ${f.content}/${f.tail} subSeed=${f.subSeed}: ${f.detail}`)
    .join("\n");

export const integrityFailures = (
  failures: readonly WalSweepFailure[],
): readonly WalSweepFailure[] => failures.filter((f) => f.detail.startsWith("I1"));

export const lostCommittedFailures = (
  failures: readonly WalSweepFailure[],
): readonly WalSweepFailure[] =>
  failures.filter((f) => f.detail.includes("lost durable committed"));
