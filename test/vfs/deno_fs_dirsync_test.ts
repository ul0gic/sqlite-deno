import { assert, assertEquals } from "@std/assert";
import { loadSqlite3 } from "../../src/glue.ts";
import { DENO_VFS_NAME, installDenoVfs } from "../../src/vfs/deno.ts";

type Sqlite3 = Awaited<ReturnType<typeof loadSqlite3>>;

const IS_WINDOWS = Deno.build.os === "windows";

interface DirSyncTrace {
  readonly dirOpens: readonly string[];
}

const realOpenSync = Deno.openSync.bind(Deno);

const traceDirSyncs = (run: (dir: string) => void): DirSyncTrace => {
  const dir = Deno.makeTempDirSync({ prefix: "dirsync-" });
  const dirOpens: string[] = [];
  Object.defineProperty(Deno, "openSync", {
    configurable: true,
    writable: true,
    value: (path: string | URL, options?: Deno.OpenOptions): Deno.FsFile => {
      const fd = realOpenSync(path, options);
      if (typeof path === "string") {
        try {
          if (Deno.statSync(path).isDirectory) dirOpens.push(path);
        } catch { /* a vanished path is never the dir we sync */ }
      }
      return fd;
    },
  });
  try {
    run(dir);
  } finally {
    Object.defineProperty(Deno, "openSync", {
      configurable: true,
      writable: true,
      value: realOpenSync,
    });
    Deno.removeSync(dir, { recursive: true });
  }
  return { dirOpens };
};

const commitOnce = (sqlite3: Sqlite3, dir: string, mode: string, sync: string): void => {
  const db = new sqlite3.oo1.DB(`${dir}/t.db`, "c", DENO_VFS_NAME);
  try {
    db.exec(`PRAGMA journal_mode=${mode}`);
    db.exec(`PRAGMA synchronous=${sync}`);
    db.exec("CREATE TABLE n(v INTEGER)");
    db.exec("BEGIN");
    db.exec("INSERT INTO n(v) VALUES (1)");
    db.exec("COMMIT");
  } finally {
    db.close();
  }
};

const assertOneCommittedRow = (sqlite3: Sqlite3, dir: string): void => {
  const db = new sqlite3.oo1.DB(`${dir}/t.db`, "c", DENO_VFS_NAME);
  try {
    assertEquals(db.selectValue("SELECT count(*) FROM n"), 1);
  } finally {
    db.close();
  }
};

const dirSyncsTargeting = (trace: DirSyncTrace, dir: string): number =>
  trace.dirOpens.filter((p) => p === dir).length;

Deno.test("the VFS fsyncs the parent directory on the create-side first xSync", async () => {
  const sqlite3 = await loadSqlite3();
  installDenoVfs(sqlite3);
  let target = "";
  const trace = traceDirSyncs((dir) => {
    target = dir;
    commitOnce(sqlite3, dir, "PERSIST", "NORMAL");
    assertOneCommittedRow(sqlite3, dir);
  });
  if (IS_WINDOWS) {
    assertEquals(
      dirSyncsTargeting(trace, target),
      0,
      `Windows must issue no directory fsync; dir opens: ${trace.dirOpens.join(", ")}`,
    );
  } else {
    assert(
      dirSyncsTargeting(trace, target) > 0,
      `no parent-directory fsync issued; dir opens: ${trace.dirOpens.join(", ")}`,
    );
  }
});

Deno.test("the create-side dir-sync fires regardless of journal mode or synchronous level", async () => {
  const sqlite3 = await loadSqlite3();
  installDenoVfs(sqlite3);
  for (const sync of ["NORMAL", "FULL", "EXTRA"]) {
    let target = "";
    const trace = traceDirSyncs((dir) => {
      target = dir;
      commitOnce(sqlite3, dir, "PERSIST", sync);
      assertOneCommittedRow(sqlite3, dir);
    });
    if (IS_WINDOWS) {
      assertEquals(
        dirSyncsTargeting(trace, target),
        0,
        `Windows PERSIST/${sync} must issue no dir-sync; dir opens: ${trace.dirOpens.join(", ")}`,
      );
    } else {
      assert(
        dirSyncsTargeting(trace, target) > 0,
        `PERSIST/${sync} issued no create-side dir-sync; dir opens: ${trace.dirOpens.join(", ")}`,
      );
    }
  }
});

Deno.test("DELETE+EXTRA adds the commit-point unlink dir-sync that NORMAL does not request", async () => {
  const sqlite3 = await loadSqlite3();
  installDenoVfs(sqlite3);
  let extraTarget = "";
  const extra = traceDirSyncs((dir) => {
    extraTarget = dir;
    commitOnce(sqlite3, dir, "DELETE", "EXTRA");
    assertOneCommittedRow(sqlite3, dir);
  });
  let normalTarget = "";
  const normal = traceDirSyncs((dir) => {
    normalTarget = dir;
    commitOnce(sqlite3, dir, "DELETE", "NORMAL");
    assertOneCommittedRow(sqlite3, dir);
  });
  if (IS_WINDOWS) {
    assertEquals(dirSyncsTargeting(extra, extraTarget), 0);
    assertEquals(dirSyncsTargeting(normal, normalTarget), 0);
  } else {
    assert(
      dirSyncsTargeting(extra, extraTarget) > dirSyncsTargeting(normal, normalTarget),
      `EXTRA must add the commit-point dir-sync: extra=${
        dirSyncsTargeting(extra, extraTarget)
      } normal=${dirSyncsTargeting(normal, normalTarget)}`,
    );
  }
});

Deno.test("PERSIST never unlinks the journal, so it issues no commit-point dir-sync", async () => {
  const sqlite3 = await loadSqlite3();
  installDenoVfs(sqlite3);
  let extraTarget = "";
  const persistExtra = traceDirSyncs((dir) => {
    extraTarget = dir;
    commitOnce(sqlite3, dir, "PERSIST", "EXTRA");
    assertOneCommittedRow(sqlite3, dir);
  });
  let normalTarget = "";
  const persistNormal = traceDirSyncs((dir) => {
    normalTarget = dir;
    commitOnce(sqlite3, dir, "PERSIST", "NORMAL");
    assertOneCommittedRow(sqlite3, dir);
  });
  if (IS_WINDOWS) {
    assertEquals(dirSyncsTargeting(persistExtra, extraTarget), 0);
    assertEquals(dirSyncsTargeting(persistNormal, normalTarget), 0);
  } else {
    assertEquals(
      dirSyncsTargeting(persistExtra, extraTarget),
      dirSyncsTargeting(persistNormal, normalTarget),
    );
  }
});

Deno.test("xDelete fsyncs the parent directory after the journal unlink under EXTRA", async () => {
  const sqlite3 = await loadSqlite3();
  installDenoVfs(sqlite3);
  let target = "";
  const journalSeen = { open: false, gone: false };
  const trace = traceDirSyncs((dir) => {
    target = dir;
    const journal = `${dir}/t.db-journal`;
    const db = new sqlite3.oo1.DB(`${dir}/t.db`, "c", DENO_VFS_NAME);
    try {
      db.exec("PRAGMA journal_mode=DELETE");
      db.exec("PRAGMA synchronous=EXTRA");
      db.exec("CREATE TABLE n(v INTEGER)");
      db.exec("BEGIN");
      db.exec("INSERT INTO n(v) VALUES (1)");
      journalSeen.open = Deno.statSync(journal).isFile;
      db.exec("COMMIT");
      journalSeen.gone = !existsSync(journal);
    } finally {
      db.close();
    }
  });
  assert(journalSeen.open, "the open transaction never created the -journal");
  assert(journalSeen.gone, "COMMIT did not unlink the -journal");
  if (IS_WINDOWS) {
    assertEquals(
      dirSyncsTargeting(trace, target),
      0,
      `Windows xDelete must issue no dir-sync; dir opens: ${trace.dirOpens.join(", ")}`,
    );
  } else {
    assert(
      dirSyncsTargeting(trace, target) >= 2,
      `expected create-side + commit-point dir-syncs; got ${dirSyncsTargeting(trace, target)}`,
    );
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
