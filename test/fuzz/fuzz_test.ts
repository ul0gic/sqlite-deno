import { assert, assertEquals } from "@std/assert";
import { asSeed } from "./model.ts";
import { generateSequence } from "./generator.ts";
import { runSeedAcrossModes } from "./driver.ts";
import { catchCorruptionViolation } from "./teeth.ts";

const CI_SEEDS = [0x1, 0xbadc0de, 0xfeed, 0x5eed, 0xc0ffee] as const;
const CI_OPS = 60;

const SOAK = Deno.env.get("SQLITE_DENO_SOAK") === "1";
const SOAK_SEEDS = Number(Deno.env.get("SQLITE_DENO_FUZZ_SEEDS") ?? "200");
const SOAK_OPS = Number(Deno.env.get("SQLITE_DENO_FUZZ_OPS") ?? "400");

const jsonReplacer = (_k: string, v: unknown): unknown =>
  typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? `blob(${v.length})` : v;

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-fuzz-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

Deno.test("generator is deterministic: one seed yields one sequence", () => {
  const a = generateSequence(asSeed(0xabc), 40);
  const b = generateSequence(asSeed(0xabc), 40);
  assertEquals(JSON.stringify(a, jsonReplacer), JSON.stringify(b, jsonReplacer));
});

Deno.test("generator varies by seed", () => {
  const a = generateSequence(asSeed(1), 40);
  const b = generateSequence(asSeed(2), 40);
  assert(JSON.stringify(a, jsonReplacer) !== JSON.stringify(b, jsonReplacer));
});

Deno.test("CI fuzz: fixed seeds across both modes never abort, keep integrity, stay usable and disposable", async () => {
  await withDir(async (dir) => {
    for (const raw of CI_SEEDS) {
      const results = await runSeedAcrossModes(dir, raw, CI_OPS);
      assertEquals(results.length, 2);
      for (const r of results) assert(r.ops === CI_OPS);
    }
  });
});

Deno.test("oracle has teeth: an on-disk-corrupted DB is DETECTED with its seed", async () => {
  await withDir(async (dir) => {
    const violation = await catchCorruptionViolation(dir);
    assert(
      violation.property === "integrity" || violation.property === "no-abort" ||
        violation.property === "usable",
      `unexpected property for a corrupt DB: ${violation.property}`,
    );
    assert(
      violation.message.includes("seed="),
      "the violation must carry its seed for deterministic replay",
    );
  });
});

Deno.test({
  name: "SOAK fuzz: wide seed sweep across both modes (env-gated SQLITE_DENO_SOAK=1)",
  ignore: !SOAK,
  fn: async () => {
    await withDir(async (dir) => {
      for (let i = 0; i < SOAK_SEEDS; i++) {
        await runSeedAcrossModes(dir, 0x9e3779b9 ^ (i * 0x01000193), SOAK_OPS);
      }
    });
  },
});
