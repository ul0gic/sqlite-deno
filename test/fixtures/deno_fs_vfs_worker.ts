import { loadSqlite3 } from "../../src/glue.ts";
import { DENO_VFS_NAME, installDenoVfs } from "../../src/vfs/deno.ts";

const emit = (line: string): void => {
  Deno.stdout.writeSync(new TextEncoder().encode(`${line}\n`));
};

const roundTrip = (sqlite3: Awaited<ReturnType<typeof loadSqlite3>>, path: string): void => {
  const db = new sqlite3.oo1.DB(path, "c", DENO_VFS_NAME);
  try {
    db.exec("CREATE TABLE t(v INTEGER)");
    db.exec("INSERT INTO t(v) VALUES (42)");
    if (db.selectValue("SELECT v FROM t") !== 42) throw new Error("readback mismatch");
  } finally {
    db.close();
  }
};

const mode = Deno.args[0] ?? "";
const target = Deno.args[1] ?? "";

const sqlite3 = await loadSqlite3();
installDenoVfs(sqlite3);

if (mode === "inside") {
  roundTrip(sqlite3, target);
  emit("ROUNDTRIP_OK");
  Deno.exit(0);
}

try {
  roundTrip(sqlite3, target);
  emit("LEAK");
  Deno.exit(2);
} catch (e) {
  emit(
    e instanceof Deno.errors.NotCapable || e instanceof Deno.errors.PermissionDenied
      ? "DENIED_RAW"
      : "FAILED_CLOSED",
  );
  Deno.exit(0);
}
