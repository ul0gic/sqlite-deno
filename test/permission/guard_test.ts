import { assertEquals } from "@std/assert";
import { basename, fromFileUrl } from "@std/path";

const WORKER = fromFileUrl(import.meta.resolve("../fixtures/guard_worker.ts"));
const SRC = fromFileUrl(import.meta.resolve("../../src/"));
const CONFIG = fromFileUrl(import.meta.resolve("../../deno.json"));

const guard = async (
  perms: readonly string[],
  mode: "read" | "write",
  target: string,
): Promise<string> => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", `--config=${CONFIG}`, "--no-prompt", ...perms, WORKER, mode, target],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await cmd.output();
  return new TextDecoder().decode(stdout).trim();
};

Deno.test("guardOpen grants an in-grant create path that resolves no symlinks", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-guard-grant-" });
  try {
    const out = await guard(
      [`--allow-read=${SRC},${dir}`, `--allow-write=${dir}`],
      "write",
      `${dir}/fresh.db`,
    );
    assertEquals(out, "granted");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("guardOpen grants an existing in-grant file opened read-only", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-guard-ro-" });
  try {
    await Deno.writeTextFile(`${dir}/present.db`, "x");
    const out = await guard([`--allow-read=${SRC},${dir}`], "read", `${dir}/present.db`);
    assertEquals(out, "granted");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("guardOpen grants an in-grant symlink whose target stays inside the grant", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-guard-symin-" });
  try {
    await Deno.mkdir(`${dir}/real`);
    await Deno.symlink(`${dir}/real`, `${dir}/link`, { type: "dir" });
    const out = await guard(
      [`--allow-read=${SRC},${dir}`, `--allow-write=${dir}`],
      "write",
      `${dir}/link/inside.db`,
    );
    assertEquals(out, "granted");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("guardOpen reports escaped for a symlinked directory component pointing outside the grant", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-guard-symdir-in-" });
  const ungranted = await Deno.makeTempDir({ prefix: "sqlite-deno-guard-symdir-out-" });
  try {
    await Deno.mkdir(`${ungranted}/real`);
    await Deno.symlink(`${ungranted}/real`, `${granted}/link`, { type: "dir" });
    const out = await guard(
      [`--allow-read=${SRC},${granted}`, `--allow-write=${granted}`],
      "write",
      `${granted}/link/secret.db`,
    );
    assertEquals(out, "escaped");
  } finally {
    await Deno.remove(granted, { recursive: true });
    await Deno.remove(ungranted, { recursive: true });
  }
});

Deno.test("guardOpen reports escaped for a symlinked final component pointing outside the grant", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-guard-symfin-in-" });
  const ungranted = await Deno.makeTempDir({ prefix: "sqlite-deno-guard-symfin-out-" });
  try {
    await Deno.mkdir(`${ungranted}/real`);
    await Deno.symlink(`${ungranted}/real/final.db`, `${granted}/finallink.db`, { type: "file" });
    const out = await guard(
      [`--allow-read=${SRC},${granted}`, `--allow-write=${granted}`],
      "write",
      `${granted}/finallink.db`,
    );
    assertEquals(out, "escaped");
  } finally {
    await Deno.remove(granted, { recursive: true });
    await Deno.remove(ungranted, { recursive: true });
  }
});

Deno.test("guardOpen refuses a parent-directory traversal leaving the grant", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-guard-trav-in-" });
  const ungranted = await Deno.makeTempDir({ prefix: "sqlite-deno-guard-trav-out-" });
  try {
    const leaf = basename(ungranted);
    const out = await guard(
      [`--allow-read=${SRC},${granted}`, `--allow-write=${granted}`],
      "write",
      `${granted}/../${leaf}/traversed.db`,
    );
    assertEquals(out !== "granted", true);
  } finally {
    await Deno.remove(granted, { recursive: true });
    await Deno.remove(ungranted, { recursive: true });
  }
});

Deno.test("guardOpen reports parent-unreadable for a create path with no parent-directory read grant", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sqlite-deno-guard-fileonly-" });
  try {
    const db = `${dir}/fileonly.db`;
    const out = await guard(
      [`--allow-read=${SRC},${db}`, `--allow-write=${db}`],
      "write",
      db,
    );
    assertEquals(out, "parent-unreadable");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
