import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const WORKER = fromFileUrl(import.meta.resolve("../fixtures/vfs_op_guard_worker.ts"));
const SRC = fromFileUrl(import.meta.resolve("../../src/"));
const CONFIG = fromFileUrl(import.meta.resolve("../../deno.json"));

const runWorker = async (
  perms: readonly string[],
  mode: string,
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

const existsSync = (path: string): boolean => {
  try {
    Deno.statSync(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
};

const scopedToGrant = (granted: string): readonly string[] => [
  `--allow-read=${SRC},${granted}`,
  `--allow-write=${granted}`,
];

Deno.test("xDelete through an in-grant directory symlink leaves the out-of-grant target untouched (SEC-003)", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-vfsdel-in-" });
  const ungranted = await Deno.makeTempDir({ prefix: "sqlite-deno-vfsdel-out-" });
  try {
    await Deno.symlink(ungranted, `${granted}/sub`);
    const escaped = `${ungranted}/victim.db-journal`;
    await Deno.writeTextFile(escaped, "out-of-grant");
    const out = await runWorker(
      scopedToGrant(granted),
      "delete",
      `${granted}/sub/victim.db-journal`,
    );
    assertEquals(out, "REFUSED");
    assertEquals(existsSync(escaped), true);
  } finally {
    await Deno.remove(granted, { recursive: true });
    await Deno.remove(ungranted, { recursive: true });
  }
});

Deno.test("xDelete of an in-grant journal still removes it (SEC-003 no over-refusal)", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-vfsdel-ok-" });
  try {
    const journal = `${granted}/app.db-journal`;
    await Deno.writeTextFile(journal, "in-grant");
    const out = await runWorker(scopedToGrant(granted), "delete", journal);
    assertEquals(out, "DELETED");
    assertEquals(existsSync(journal), false);
  } finally {
    await Deno.remove(granted, { recursive: true });
  }
});

Deno.test("xAccess through an in-grant symlink to an out-of-grant file reports not-accessible (SEC-003)", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-vfsacc-in-" });
  const ungranted = await Deno.makeTempDir({ prefix: "sqlite-deno-vfsacc-out-" });
  try {
    const escaped = `${ungranted}/secret.db`;
    await Deno.writeTextFile(escaped, "out-of-grant metadata");
    await Deno.symlink(escaped, `${granted}/peek.db`);
    const out = await runWorker(scopedToGrant(granted), "access", `${granted}/peek.db`);
    assertEquals(out, "REFUSED");
    assertEquals(existsSync(escaped), true);
  } finally {
    await Deno.remove(granted, { recursive: true });
    await Deno.remove(ungranted, { recursive: true });
  }
});

Deno.test("xAccess of an in-grant file still reports accessible (SEC-003 no over-refusal)", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-vfsacc-ok-" });
  try {
    const file = `${granted}/present.db`;
    await Deno.writeTextFile(file, "in-grant");
    const out = await runWorker(scopedToGrant(granted), "access", file);
    assertEquals(out, "ACCESSED");
  } finally {
    await Deno.remove(granted, { recursive: true });
  }
});

Deno.test("syncDir through an in-grant directory symlink refuses to fsync the out-of-grant dir (SEC-003)", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-vfssync-in-" });
  const ungranted = await Deno.makeTempDir({ prefix: "sqlite-deno-vfssync-out-" });
  try {
    await Deno.symlink(ungranted, `${granted}/sub`);
    const out = await runWorker(scopedToGrant(granted), "syncdir", `${granted}/sub/app.db`);
    assertEquals(out, "REFUSED");
  } finally {
    await Deno.remove(granted, { recursive: true });
    await Deno.remove(ungranted, { recursive: true });
  }
});

Deno.test("syncDir of the in-grant directory still fsyncs it (SEC-003 no over-refusal)", async () => {
  const granted = await Deno.makeTempDir({ prefix: "sqlite-deno-vfssync-ok-" });
  try {
    const out = await runWorker(scopedToGrant(granted), "syncdir", `${granted}/app.db`);
    assertEquals(out, "SYNCED");
  } finally {
    await Deno.remove(granted, { recursive: true });
  }
});
