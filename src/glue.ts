// @ts-types="./wasm/sqlite3.d.ts"
import sqlite3InitModule from "./wasm/sqlite3.mjs";
import type { Sqlite3Static } from "./wasm/sqlite3.d.ts";
import type { FileStruct, IoMethodsStruct, VfsStruct } from "./wasm/struct.ts";

export type { Sqlite3Static };
export type { FileStruct, IoMethodsStruct, VfsStruct } from "./wasm/struct.ts";

const WASM_URL = import.meta.resolve("./wasm/sqlite3.wasm");

/**
 * Typed constructors for the binder structs. They reinterpret each freshly
 * created instance through the precise `$`-member surface the upstream `.d.mts`
 * omits — the single boundary where the binder's generated accessors are typed.
 */
export interface StructFactory {
  readonly vfs: (ptr?: number) => VfsStruct;
  readonly ioMethods: () => IoMethodsStruct;
  readonly file: (ptr?: number) => FileStruct;
}

/**
 * The instantiated SQLite engine plus the marshaling surface our VFS needs.
 * `installVfs` and the struct binders are how a pure-JS VFS attaches to the
 * prebuilt wasm without a recompile.
 */
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
    // The binder instances carry the generated `$` accessors the upstream types
    // omit; each view extends its upstream struct, so this is a downcast to the
    // accurate runtime shape — the one boundary where that surface is asserted.
    vfs: (ptr) =>
      (ptr === undefined ? new s.capi.sqlite3_vfs() : new s.capi.sqlite3_vfs(ptr)) as VfsStruct,
    ioMethods: () => new s.capi.sqlite3_io_methods() as IoMethodsStruct,
    file: (ptr) => ptr === undefined ? new s.capi.sqlite3_file() : new s.capi.sqlite3_file(ptr),
  },
});

const silenceBundledVfsProbes = async (wasmBinary: Uint8Array): Promise<Sqlite3Static> => {
  // The bundled OPFS auto-installers run on bootstrap and warn to the console
  // because Deno has no `globalThis.location`. Route the one-time bootstrap
  // warnings to no-ops; the module reads and deletes this config itself, so the
  // override is gone after instantiation.
  const host = globalThis as unknown as ConfigHost;
  const prior = host.sqlite3ApiConfig;
  host.sqlite3ApiConfig = { warn: () => {}, error: () => {} };
  try {
    return await sqlite3InitModule({ wasmBinary });
  } finally {
    // The module deletes the key during bootstrap; restoring `undefined` leaves
    // the falsy state the bootstrap expects if no prior config was present.
    host.sqlite3ApiConfig = prior;
  }
};

/**
 * Instantiates the engine once and reuses it. The wasm is read from the package
 * via a `file:` fetch (no `--allow-net`, no remote download) and handed its own
 * bytes, so the only capability required is read access to the vendored
 * `sqlite3.wasm`. The wasm itself has no ambient authority — all I/O flows back
 * out through our VFS.
 */
export const loadSqlite3 = (): Promise<Sqlite3> => {
  instance ??= readWasmBytes().then(silenceBundledVfsProbes).then(toSqlite3);
  return instance;
};
