// @ts-types="./wasm/sqlite3.d.ts"
import sqlite3InitModule from "./wasm/sqlite3.mjs";
import type { Sqlite3Static } from "./wasm/sqlite3.d.ts";
import type { FileStruct, IoMethodsStruct, VfsStruct } from "./wasm/struct.ts";

export type { Sqlite3Static };
export type { FileStruct, IoMethodsStruct, VfsStruct } from "./wasm/struct.ts";

const WASM_URL = import.meta.resolve("./wasm/sqlite3.wasm");

/** Typed constructors for the binder structs — the one boundary that types the binder's `$` accessors. */
export interface StructFactory {
  readonly vfs: (ptr?: number) => VfsStruct;
  readonly ioMethods: () => IoMethodsStruct;
  readonly file: (ptr?: number) => FileStruct;
}

/** The instantiated engine plus the marshaling surface a pure-JS VFS attaches through (no recompile). */
export interface Sqlite3 {
  readonly capi: Sqlite3Static["capi"];
  readonly wasm: Sqlite3Static["wasm"];
  readonly vfs: Sqlite3Static["vfs"];
  readonly oo1: Sqlite3Static["oo1"];
  readonly version: Sqlite3Static["version"];
  readonly struct: StructFactory;
}

let instance: Promise<Sqlite3> | undefined;

const readWasmBytes = async (): Promise<Uint8Array> => {
  const res = await fetch(WASM_URL);
  return new Uint8Array(await res.arrayBuffer());
};

interface BootstrapConfig {
  readonly warn: () => void;
  readonly error: () => void;
}

interface ConfigHost {
  sqlite3ApiConfig: BootstrapConfig | undefined;
}

const toSqlite3 = (s: Sqlite3Static): Sqlite3 => ({
  capi: s.capi,
  wasm: s.wasm,
  vfs: s.vfs,
  oo1: s.oo1,
  version: s.version,
  struct: {
    // Downcast to the runtime shape: binder instances carry the generated `$` accessors upstream types omit.
    vfs: (ptr) =>
      (ptr === undefined ? new s.capi.sqlite3_vfs() : new s.capi.sqlite3_vfs(ptr)) as VfsStruct,
    ioMethods: () => new s.capi.sqlite3_io_methods() as IoMethodsStruct,
    file: (ptr) => ptr === undefined ? new s.capi.sqlite3_file() : new s.capi.sqlite3_file(ptr),
  },
});

const silenceBundledVfsProbes = async (wasmBinary: Uint8Array): Promise<Sqlite3Static> => {
  // Bundled OPFS auto-installers warn on bootstrap (Deno has no `globalThis.location`); silence them.
  const host = globalThis as unknown as ConfigHost;
  const prior = host.sqlite3ApiConfig;
  host.sqlite3ApiConfig = { warn: () => {}, error: () => {} };
  try {
    return await sqlite3InitModule({ wasmBinary });
  } finally {
    // Bootstrap deletes the key; restoring `undefined` keeps the falsy state it expects.
    host.sqlite3ApiConfig = prior;
  }
};

/** Instantiate once and reuse; wasm read via `file:` fetch, so the sole capability is read on the vendored bytes. */
export const loadSqlite3 = (): Promise<Sqlite3> => {
  instance ??= readWasmBytes().then(silenceBundledVfsProbes).then(toSqlite3);
  return instance;
};
