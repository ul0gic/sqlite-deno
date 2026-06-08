import { loadSqlite3 } from "../../src/glue.ts";
import { guardOpen } from "../../src/vfs/guard.ts";

const emit = (line: string): void => {
  Deno.stdout.writeSync(new TextEncoder().encode(`${line}\n`));
};

const mode = Deno.args[0] ?? "";
const target = Deno.args[1] ?? "";

const sqlite3 = await loadSqlite3();
const flags = mode === "read"
  ? sqlite3.capi.SQLITE_OPEN_READONLY
  : sqlite3.capi.SQLITE_OPEN_READWRITE | sqlite3.capi.SQLITE_OPEN_CREATE;

emit(guardOpen(sqlite3, target, flags).kind);
Deno.exit(0);
