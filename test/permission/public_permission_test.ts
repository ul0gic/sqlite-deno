import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { basename, fromFileUrl } from "@std/path";

const WORKER = fromFileUrl(import.meta.resolve("../fixtures/public_api_worker.ts"));
const SRC = fromFileUrl(import.meta.resolve("../../src/"));
const CONFIG = fromFileUrl(import.meta.resolve("../../deno.json"));

interface Run {
  readonly code: number;
  readonly out: string;
}

const runWorker = async (
  perms: readonly string[],
  mode: string,
  target: string,
): Promise<Run> => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", `--config=${CONFIG}`, "--no-prompt", ...perms, WORKER, mode, target],
    stdout: "piped",
    stderr: "null",
  });
  const { code, stdout } = await cmd.output();
  return { code, out: new TextDecoder().decode(stdout).trim() };
};

const existsSync = (path: string): boolean => {
  try {
    Deno.statSync(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
};

Deno.test("openDatabase round-trips under a read/write grant scoped to the db dir only", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-pub-perm-" });
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

Deno.test("openDatabase needs no ffi, net, or env grant and fetches nothing on first run", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-pub-nofetch-" });
  try {
    const db = `${dir}/nofetch.db`;
    const { code, out } = await runWorker(
      [`--allow-read=${SRC},${dir}`, `--allow-write=${dir}`],
      "fetchspy",
      db,
    );
    assertEquals(code, 0);
    assertEquals(out, "NO_NETWORK_FETCH");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("openDatabase on a path outside the grant fails closed without creating the file", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-pub-in-" });
  const ungranted = await Deno.makeTempDir({ prefix: "sqlite-deno-pub-out-" });
  try {
    const outside = `${ungranted}/forbidden.db`;
    const { code, out } = await runWorker(
      [`--allow-read=${SRC},${granted}`, `--allow-write=${granted}`],
      "outside",
      outside,
    );
    assertEquals(code, 0);
    assert(out === "DENIED_RAW" || out === "DENIED_TYPED" || out === "FAILED_CLOSED");
    assertEquals(out.includes("LEAK"), false);
    assertEquals(existsSync(outside), false);
  } finally {
    await Deno.remove(granted, { recursive: true });
    await Deno.remove(ungranted, { recursive: true });
  }
});

Deno.test("openDatabase fails closed with no filesystem grant for the db path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-pub-none-" });
  try {
    const db = `${dir}/nogrant.db`;
    const { code, out } = await runWorker([`--allow-read=${SRC}`], "nogrant", db);
    assertEquals(code, 0);
    assert(out === "DENIED_RAW" || out === "DENIED_TYPED" || out === "FAILED_CLOSED");
    assertEquals(out.includes("LEAK"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("openDatabase through a parent-directory traversal out of the grant fails closed without a usable db", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-pub-trav-in-" });
  const ungranted = await Deno.makeTempDir({ prefix: "sqlite-deno-pub-trav-out-" });
  try {
    const escaped = `${granted}/../${basename(ungranted)}/traversed.db`;
    const { code, out } = await runWorker(
      [`--allow-read=${SRC},${granted}`, `--allow-write=${granted}`],
      "traversal",
      escaped,
    );
    assertEquals(code, 0);
    assert(out === "DENIED_RAW" || out === "DENIED_TYPED" || out === "FAILED_CLOSED");
    assertEquals(out.includes("LEAK"), false);
    assertEquals(existsSync(`${ungranted}/traversed.db`), false);
  } finally {
    await Deno.remove(granted, { recursive: true });
    await Deno.remove(ungranted, { recursive: true });
  }
});

Deno.test("openDatabase through a symlink escaping the grant is refused before any file is created (SEC-001)", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-pub-sym-in-" });
  const ungranted = await Deno.makeTempDir({ prefix: "sqlite-deno-pub-sym-out-" });
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
    assertEquals(out, "DENIED_TYPED");
    assertEquals(out.includes("LEAK"), false);
    assertEquals(existsSync(escapedReal), false);
    assertEquals(existsSync(`${escapedReal}-journal`), false);
  } finally {
    await Deno.remove(granted, { recursive: true });
    await Deno.remove(ungranted, { recursive: true });
  }
});

Deno.test("openDatabase through a symlinked final component escaping the grant is refused with no leak (SEC-001)", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-pub-symfin-in-" });
  const ungranted = await Deno.makeTempDir({ prefix: "sqlite-deno-pub-symfin-out-" });
  try {
    await Deno.mkdir(`${ungranted}/real`);
    const escapedReal = `${ungranted}/real/final.db`;
    await Deno.symlink(escapedReal, `${granted}/finallink.db`, { type: "file" });
    const { code, out } = await runWorker(
      [`--allow-read=${SRC},${granted}`, `--allow-write=${granted}`],
      "symlink",
      `${granted}/finallink.db`,
    );
    assertEquals(code, 0);
    assertEquals(out, "DENIED_TYPED");
    assertEquals(existsSync(escapedReal), false);
  } finally {
    await Deno.remove(granted, { recursive: true });
    await Deno.remove(ungranted, { recursive: true });
  }
});

Deno.test("openDatabase through an in-grant symlink whose target stays inside the grant still works (SEC-001 no over-refusal)", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-pub-syminside-" });
  try {
    await Deno.mkdir(`${granted}/real`);
    await Deno.symlink(`${granted}/real`, `${granted}/link`, { type: "dir" });
    const { code, out } = await runWorker(
      [`--allow-read=${SRC},${granted}`, `--allow-write=${granted}`],
      "inside",
      `${granted}/link/inside.db`,
    );
    assertEquals(code, 0);
    assertStringIncludes(out, "ROUNDTRIP_OK");
    assert(Deno.statSync(`${granted}/real/inside.db`).size > 0);
  } finally {
    await Deno.remove(granted, { recursive: true });
  }
});
