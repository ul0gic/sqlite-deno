import { openDatabase } from "../../src/mod.ts";
import { SqliteCantOpenError } from "../../src/errors.ts";

const emit = (line: string): void => {
  Deno.stdout.writeSync(new TextEncoder().encode(`${line}\n`));
};

const roundTrip = async (path: string): Promise<void> => {
  using db = await openDatabase(path);
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
  db.prepare("INSERT INTO t(id, name) VALUES (?, ?)").run(1, "alice");
  const row = db.prepare<{ id: number; name: string }>("SELECT id, name FROM t WHERE id = ?")
    .get(1);
  if (row?.name !== "alice") throw new Error("readback mismatch");
};

const mode = Deno.args[0] ?? "";
const target = Deno.args[1] ?? "";

if (mode === "fetchspy") {
  const realFetch = globalThis.fetch;
  let networkFetched = false;
  globalThis.fetch = ((...args: Parameters<typeof realFetch>) => {
    const input = args[0];
    const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (!href.startsWith("file:")) networkFetched = true;
    return realFetch(...args);
  }) as typeof realFetch;
  await roundTrip(target);
  emit(networkFetched ? "NETWORK_FETCH" : "NO_NETWORK_FETCH");
  Deno.exit(0);
}

if (mode === "inside") {
  await roundTrip(target);
  emit("ROUNDTRIP_OK");
  Deno.exit(0);
}

try {
  await roundTrip(target);
  emit("LEAK");
  Deno.exit(2);
} catch (e) {
  if (e instanceof Deno.errors.NotCapable || e instanceof Deno.errors.PermissionDenied) {
    emit("DENIED_RAW");
  } else if (e instanceof SqliteCantOpenError) {
    emit("DENIED_TYPED");
  } else {
    emit("FAILED_CLOSED");
  }
  Deno.exit(0);
}
