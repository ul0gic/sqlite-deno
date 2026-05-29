import { loadSqlite3 } from "../../src/glue.ts";
import { DENO_VFS_NAME, installDenoVfs } from "../../src/vfs/deno.ts";

const path = Deno.args[0] ?? "";
const sqlite3 = await loadSqlite3();
installDenoVfs(sqlite3);

const db = new sqlite3.oo1.DB(path, "c", DENO_VFS_NAME);
db.exec("PRAGMA journal_mode=DELETE");
db.exec("CREATE TABLE IF NOT EXISTS kv(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");

Deno.stdout.writeSync(new TextEncoder().encode("READY\n"));

let v = 1;
for (;;) {
  db.exec("BEGIN");
  for (let r = 0; r < 16; r++) {
    db.exec({ sql: "INSERT INTO kv(v) VALUES ($v)", bind: { $v: v } });
    v++;
  }
  db.exec("COMMIT");
}
