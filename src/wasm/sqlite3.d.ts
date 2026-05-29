import type { Sqlite3Static } from "./index.d.mts";

export interface Sqlite3InitOptions {
  readonly wasmBinary: Uint8Array;
  readonly print?: (msg: string) => void;
  readonly printErr?: (msg: string) => void;
}

declare const sqlite3InitModule: (opts: Sqlite3InitOptions) => Promise<Sqlite3Static>;

export default sqlite3InitModule;
export type { Sqlite3Static };
