import { dirname } from "@std/path";
import { loadSqlite3 } from "../../src/glue.ts";
import { resultCodes } from "../../src/vfs/errors.ts";
import { type OpenRegistry, syncDir } from "../../src/vfs/io.ts";
import { createVfsMethods } from "../../src/vfs/namespace.ts";

const emit = (line: string): void => {
  Deno.stdout.writeSync(new TextEncoder().encode(`${line}\n`));
};

const mode = Deno.args[0] ?? "";
const target = Deno.args[1] ?? "";

const sqlite3 = await loadSqlite3();
const { wasm } = sqlite3;
const open: OpenRegistry = new Map();
const vfs = createVfsMethods({
  sqlite3,
  open,
  rc: resultCodes(sqlite3),
  ioMethodsPtr: 0,
  setPMethods: () => {},
});

const withCStr = <T>(s: string, run: (ptr: number) => T): T => {
  const ptr = wasm.allocCString(s, false);
  try {
    return run(ptr);
  } finally {
    wasm.dealloc(ptr);
  }
};

if (mode === "delete") {
  const rc = withCStr(target, (z) => vfs.xDelete(0, z, 0));
  emit(rc === sqlite3.capi.SQLITE_OK ? "DELETED" : "REFUSED");
  Deno.exit(0);
}

if (mode === "access") {
  const stack = wasm.pstack.pointer;
  try {
    const pResOut = wasm.pstack.alloc(4);
    withCStr(target, (z) => vfs.xAccess(0, z, 0, pResOut));
    emit(Number(wasm.peek32(pResOut)) === 1 ? "ACCESSED" : "REFUSED");
  } finally {
    wasm.pstack.restore(stack);
  }
  Deno.exit(0);
}

if (mode === "syncdir") {
  try {
    syncDir(dirname(target));
    emit("SYNCED");
  } catch {
    emit("REFUSED");
  }
  Deno.exit(0);
}

emit("UNKNOWN_MODE");
Deno.exit(1);
