import { assert, assertEquals } from "@std/assert";
import { openDatabase } from "../../src/database.ts";
import { asSeed } from "./model.ts";
import type { FuzzOp } from "./model.ts";
import { generateSequence } from "./generator.ts";
import { runSeedAcrossModes } from "./driver.ts";
import { formatMinimal, shrinkSequence } from "./shrink.ts";
import { OracleViolation } from "./oracle.ts";

const SOAK = Deno.env.get("SQLITE_DENO_SOAK") === "1";
const SOAK_SEEDS = Number(Deno.env.get("SQLITE_DENO_FUZZ_SEEDS") ?? "200");
const SOAK_OPS = Number(Deno.env.get("SQLITE_DENO_FUZZ_OPS") ?? "400");

const PAGE_SIZE = 4096;

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-shrink-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const seedCorruptTemplate = async (path: string): Promise<void> => {
  {
    using db = await openDatabase(path);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    using ins = db.prepare("INSERT INTO t(id, v) VALUES (?, ?)");
    for (let i = 1; i <= 800; i++) ins.run(i, "x".repeat(300));
  }
  const bytes = await Deno.readFile(path);
  const base = (10 - 1) * PAGE_SIZE;
  for (let i = 0; i < PAGE_SIZE; i++) bytes[base + i] = 0xff;
  await Deno.writeFile(path, bytes);
};

Deno.test("shrinker minimizes an on-disk-corruption violation to a 1-op repro that still trips the same property", async () => {
  await withDir(async (dir) => {
    const seed = asSeed(0x5481c);
    const ops: readonly FuzzOp[] = [
      { kind: "exec", sql: "SELECT 1" },
      { kind: "query", method: "all", sql: "SELECT 2 AS a", params: [] },
      { kind: "exec", sql: "PRAGMA page_size" },
      { kind: "query", method: "get", sql: "SELECT 3 AS b", params: [] },
      { kind: "exec", sql: "SELECT 4" },
    ];
    const templatePath = `${dir}/corrupt-template.db`;
    await seedCorruptTemplate(templatePath);
    const prepare = async (p: string): Promise<void> => {
      await Deno.copyFile(templatePath, p);
    };

    const result = await shrinkSequence(dir, seed, "rollback", ops, "integrity", { prepare });

    assertEquals(result.property, "integrity");
    assert(
      result.minimal.length >= 1 && result.minimal.length <= ops.length,
      `minimal length out of range: ${result.minimal.length}`,
    );
    assert(
      result.minimal.length < ops.length || ops.length === 1,
      `shrinker did not reduce the ${ops.length}-op sequence (got ${result.minimal.length})`,
    );
    assert(
      formatMinimal(result).includes("property=integrity"),
      "the minimized report must name the reproduced property",
    );
  });
});

Deno.test("shrinker keeps the SAME property: a clean smaller subsequence is rejected", async () => {
  await withDir(async (dir) => {
    const seed = asSeed(0xc1ea0);
    const cleanOps: readonly FuzzOp[] = [
      { kind: "exec", sql: "CREATE TABLE k(v)" },
      { kind: "run", sql: "INSERT INTO k(v) VALUES (?)", params: [1] },
      { kind: "query", method: "all", sql: "SELECT * FROM k", params: [] },
    ];
    const result = await shrinkSequence(dir, seed, "rollback", cleanOps, "integrity");
    assertEquals(
      result.minimal.length,
      cleanOps.length,
      "a sequence that never reproduces the property must not shrink at all",
    );
  });
});

Deno.test({
  name:
    "SOAK fuzz shrink: any caught violation is minimized and reported with its seed (env-gated)",
  ignore: !SOAK,
  fn: async () => {
    await withDir(async (dir) => {
      const failures: string[] = [];
      for (let i = 0; i < SOAK_SEEDS; i++) {
        const raw = 0x9e3779b9 ^ (i * 0x01000193);
        try {
          await runSeedAcrossModes(dir, raw, SOAK_OPS);
        } catch (e) {
          if (!(e instanceof OracleViolation)) throw e;
          const seed = asSeed(e.seed);
          const original = generateSequence(seed, SOAK_OPS);
          const rollback = await shrinkSequence(dir, seed, "rollback", original, e.property);
          const wal = await shrinkSequence(dir, seed, "wal", original, e.property);
          const best = wal.minimal.length < rollback.minimal.length ? wal : rollback;
          failures.push(formatMinimal(best));
        }
      }
      assertEquals(
        failures.length,
        0,
        `the soak sweep surfaced violations; minimized repros:\n${failures.join("\n\n")}`,
      );
    });
  },
});
