import { openDatabase } from "../../src/database.ts";
import { asSeed } from "./model.ts";
import { runSequence } from "./driver.ts";
import { OracleViolation } from "./oracle.ts";

const PAGE_SIZE = 4096;

const seedCorruptDb = async (path: string): Promise<void> => {
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

// Oracle negative control: a publicly-corrupted DB must trip integrity/no-abort/usable,
// proving the oracle can fail. Returns the caught OracleViolation.
export const catchCorruptionViolation = async (dir: string): Promise<OracleViolation> => {
  const path = `${dir}/teeth.db`;
  await seedCorruptDb(path);
  try {
    await runSequence(dir, asSeed(0xdead), "rollback", 6, path);
  } catch (e) {
    if (e instanceof OracleViolation) return e;
    throw e;
  }
  throw new Error("teeth control stayed clean: the oracle did not detect on-disk corruption");
};
