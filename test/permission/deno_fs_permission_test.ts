import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";

const WORKER = fromFileUrl(import.meta.resolve("../fixtures/deno_fs_vfs_worker.ts"));
const SRC = fromFileUrl(import.meta.resolve("../../src/"));
const CONFIG = fromFileUrl(import.meta.resolve("../../deno.json"));

interface Run {
  readonly code: number;
  readonly out: string;
}

const runWorker = async (perms: readonly string[], mode: string, target: string): Promise<Run> => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      `--config=${CONFIG}`,
      "--no-prompt",
      ...perms,
      WORKER,
      mode,
      target,
    ],
    stdout: "piped",
    stderr: "null",
  });
  const { code, stdout } = await cmd.output();
  return { code, out: new TextDecoder().decode(stdout).trim() };
};

Deno.test("file VFS round-trips under a read/write grant scoped to the db dir only", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-perm-" });
  try {
    const db = `${dir}/scoped.db`;
    const { code, out } = await runWorker(
      [`--allow-read=${SRC},${dir}`, `--allow-write=${dir}`],
      "inside",
      db,
    );
    assertEquals(code, 0);
    assertStringIncludes(out, "ROUNDTRIP_OK");
    assert(Deno.statSync(db).size > 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a path outside the grant fails closed without widening it", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-perm-in-" });
  const ungranted = await Deno.makeTempDir({ prefix: "sqlite-deno-perm-out-" });
  try {
    const outside = `${ungranted}/forbidden.db`;
    const { code, out } = await runWorker(
      [`--allow-read=${SRC},${granted}`, `--allow-write=${granted}`],
      "outside",
      outside,
    );
    assertEquals(code, 0);
    assert(out === "DENIED_RAW" || out === "FAILED_CLOSED");
    assertEquals(out.includes("LEAK"), false);
    assertEquals(existsSync(outside), false);
  } finally {
    await Deno.remove(granted, { recursive: true });
    await Deno.remove(ungranted, { recursive: true });
  }
});

Deno.test("the db path fails closed with no filesystem grant for it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-perm-none-" });
  try {
    const db = `${dir}/nogrant.db`;
    const { code, out } = await runWorker([`--allow-read=${SRC}`], "nogrant", db);
    assertEquals(code, 0);
    assert(out === "DENIED_RAW" || out === "FAILED_CLOSED");
    assertEquals(out.includes("LEAK"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a symlink whose target escapes the grant is refused by the VFS guard before any file is created (SEC-001)", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-perm-sym-in-" });
  const ungranted = await Deno.makeTempDir({ prefix: "sqlite-deno-perm-sym-out-" });
  try {
    await Deno.mkdir(`${ungranted}/real`);
    await Deno.symlink(`${ungranted}/real`, `${granted}/link`, { type: "dir" });
    const escapedReal = `${ungranted}/real/secret.db`;
    const { code, out } = await runWorker(
      [`--allow-read=${SRC},${granted}`, `--allow-write=${granted}`],
      "symlink",
      `${granted}/link/secret.db`,
    );
    assertEquals(code, 0);
    assertEquals(out, "FAILED_CLOSED");
    assertEquals(out.includes("LEAK"), false);
    assertEquals(existsSync(escapedReal), false);
  } finally {
    await Deno.remove(granted, { recursive: true });
    await Deno.remove(ungranted, { recursive: true });
  }
});

const existsSync = (path: string): boolean => {
  try {
    Deno.statSync(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
};
