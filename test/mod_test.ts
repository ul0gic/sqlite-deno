import { assertMatch } from "@std/assert";
import { VERSION } from "../src/mod.ts";

Deno.test("mod exports a semver VERSION string", () => {
  assertMatch(VERSION, /^\d+\.\d+\.\d+$/);
});
