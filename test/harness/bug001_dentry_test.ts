import { assert } from "@std/assert";
import { loadSqlite3 } from "../../src/glue.ts";
import { installCrashVfs } from "./crash-vfs.ts";
import {
  journalCreateMidUpdateIndices,
  journalDeleteIndices,
  runDentryScenario,
} from "./scenarios.ts";

const SEEDS = [1, 7, 1337, 90210, 2654435761, 0xdead, 0xbeef, 123456789] as const;
const SPEC = { txns: 4, rowsPerTxn: 2, dbName: "/dentry.db" } as const;

const withScenarioVfs = async <T>(
  vfsName: string,
  fn: (
    sqlite3: Awaited<ReturnType<typeof loadSqlite3>>,
    recorder: ReturnType<typeof installCrashVfs>,
    dir: string,
  ) => T | Promise<T>,
): Promise<T> => {
  const sqlite3 = await loadSqlite3();
  const recorder = installCrashVfs(sqlite3, { vfsName, realSync: true });
  const dir = await Deno.makeTempDir({ prefix: "bug001-" });
  try {
    return await fn(sqlite3, recorder, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

Deno.test("BUG-001 T-A: a lost journal creation never corrupts the database (I1 holds)", async () => {
  await withScenarioVfs("crash-bug001-ta", async (sqlite3, recorder, dir) => {
    const summary = await runDentryScenario(sqlite3, recorder, dir, {
      spec: SPEC,
      seeds: SEEDS,
      indices: journalCreateMidUpdateIndices,
    });
    assert(summary.runs > 0, "T-A swept no crash points");
    const corrupt = summary.failures.filter((f) => f.integrityFailed);
    assert(
      corrupt.length === 0,
      `T-A produced integrity corruption (not expected — a missing journal must not corrupt):\n${
        corrupt.slice(0, 8).map((f) => `k=${f.crashIndex} seed=${f.seed}: ${f.detail}`).join("\n")
      }`,
    );
  });
});

Deno.test("BUG-001 T-B: a lost journal deletion (zombie hot journal) ROLLS BACK a committed txn", async () => {
  await withScenarioVfs("crash-bug001-tb", async (sqlite3, recorder, dir) => {
    const summary = await runDentryScenario(sqlite3, recorder, dir, {
      spec: SPEC,
      seeds: SEEDS,
      indices: journalDeleteIndices,
    });
    assert(summary.runs > 0, "T-B swept no crash points");
    const committedLoss = summary.failures.filter((f) =>
      f.committedLostAt !== null && !f.integrityFailed
    );
    assert(
      committedLoss.length > 0,
      "T-B did NOT reproduce committed-data loss. Either a directory-fsync fix landed (re-adjudicate BUG-001 and update this guard) or the harness no longer models a droppable unlink dentry — do not silently relax it.",
    );
    const firstSeed = committedLoss[0]?.seed;
    const firstK = committedLoss[0]?.crashIndex;
    assert(
      firstSeed !== undefined && firstK !== undefined,
      "expected a reproducing seed for the T-B committed loss",
    );
  });
});

Deno.test("BUG-001 T-B: every zombie-journal reconstruction is structurally valid (I1 holds even when a commit is lost)", async () => {
  await withScenarioVfs("crash-bug001-tb-i1", async (sqlite3, recorder, dir) => {
    const summary = await runDentryScenario(sqlite3, recorder, dir, {
      spec: SPEC,
      seeds: SEEDS,
      indices: journalDeleteIndices,
    });
    const corruptFromDrop = summary.failures.filter((f) => f.integrityFailed);
    assert(
      corruptFromDrop.length === 0,
      `the zombie-journal rollback must leave a structurally intact DB (I1=ok); got integrity failures:\n${
        corruptFromDrop.slice(0, 8).map((f) => `k=${f.crashIndex} seed=${f.seed}: ${f.detail}`)
          .join("\n")
      }`,
    );
  });
});
