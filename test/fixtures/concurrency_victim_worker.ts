import { loadSqlite3 } from "../../src/glue.ts";
import { ACCOUNTS, installModeVfs, parseLockingMode } from "../harness/concurrency.ts";

const args = Deno.args;
const path = args[0] ?? "";
const mode = parseLockingMode(args[1] ?? "xstrict");

const sqlite3 = await loadSqlite3();
const vfsName = installModeVfs(sqlite3, mode);

const db = new sqlite3.oo1.DB(path, "w", vfsName);
db.exec("PRAGMA busy_timeout=15000");
db.exec("BEGIN IMMEDIATE");
db.exec({ sql: "UPDATE accounts SET balance=balance-100 WHERE id=$a", bind: { $a: 0 } });
db.exec({
  sql: "UPDATE accounts SET balance=balance+100 WHERE id=$b",
  bind: { $b: 1 % ACCOUNTS },
});
db.exec("UPDATE meta SET commit_count=commit_count+1 WHERE id=0");

Deno.stdout.writeSync(new TextEncoder().encode("READY\n"));

const buf = new Int32Array(new SharedArrayBuffer(4));
for (;;) Atomics.wait(buf, 0, 0, 1000);
