import type { Sqlite3 } from "./glue.ts";
import type { StmtPtr } from "./wasm/ptr.ts";
import { SqliteMisuseError } from "./errors.ts";

/** The values crossing the binding boundary. i64 narrows to `number` when exact, else `bigint`. */
export type SqlValue = number | bigint | string | Uint8Array | null;

const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_NULL = 5;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

const MAX_I64 = 2n ** 63n - 1n;
const MIN_I64 = -(2n ** 63n);

/** Narrows i64 to `number` when it round-trips exactly, else keeps the `bigint`. */
export const narrowInt = (v: bigint): number | bigint =>
  v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : v;

/** BLOB bytes are engine-owned until the next sqlite3_* call, so slice before returning (wasm.md). */
export const readColumn = (
  sqlite3: Sqlite3,
  stmt: StmtPtr,
  col: number,
): SqlValue => {
  const { capi, wasm } = sqlite3;
  const type = capi.sqlite3_column_type(stmt, col);
  switch (type) {
    case SQLITE_INTEGER:
      return narrowInt(capi.sqlite3_column_int64(stmt, col));
    case SQLITE_FLOAT:
      return capi.sqlite3_column_double(stmt, col);
    case SQLITE_TEXT:
      return capi.sqlite3_column_text(stmt, col);
    case SQLITE_BLOB: {
      const n = capi.sqlite3_column_bytes(stmt, col);
      const src = capi.sqlite3_column_blob(stmt, col);
      if (n === 0) return new Uint8Array(0);
      return wasm.heap8u().slice(src, src + n);
    }
    case SQLITE_NULL:
      return null;
    default:
      throw new SqliteMisuseError(
        `unexpected SQLite column type: ${type}`,
        capi.SQLITE_MISUSE,
        capi.SQLITE_MISUSE,
      );
  }
};

// Pointer route is required: upstream's JS-string value path references an undefined `pMem`.
// SQLITE_TRANSIENT makes SQLite copy before the `finally` frees the allocation.
const bindText = (sqlite3: Sqlite3, stmt: StmtPtr, idx: number, value: string): number => {
  const { capi, wasm } = sqlite3;
  const [ptr, n] = wasm.allocCString(value, true);
  try {
    return capi.sqlite3_bind_text(stmt, idx, ptr, n, capi.SQLITE_TRANSIENT);
  } finally {
    wasm.dealloc(ptr);
  }
};

// Take the heap view only after `alloc` (the last call that can grow and detach it); SQLITE_TRANSIENT copies before free.
const bindBlob = (sqlite3: Sqlite3, stmt: StmtPtr, idx: number, value: Uint8Array): number => {
  const { capi, wasm } = sqlite3;
  const n = value.length;
  // An empty blob still needs a non-null pointer: a null pointer binds SQL NULL, not a zero-length blob.
  const ptr = wasm.alloc(n === 0 ? 1 : n);
  try {
    if (n > 0) wasm.heap8u().set(value, ptr);
    return capi.sqlite3_bind_blob(stmt, idx, ptr, n, capi.SQLITE_TRANSIENT);
  } finally {
    wasm.dealloc(ptr);
  }
};

/** Binds one param at 1-based `idx`. `value` is untrusted input (security.md); unsupported shapes are typed misuse, never coercion. */
export const bindValue = (
  sqlite3: Sqlite3,
  stmt: StmtPtr,
  idx: number,
  value: unknown,
): number => {
  const { capi } = sqlite3;
  if (value === null) {
    // Upstream's `sqlite3_bind_null` wrapper returns void, not the rc; a valid index never fails.
    capi.sqlite3_bind_null(stmt, idx);
    return capi.SQLITE_OK;
  }
  if (typeof value === "bigint") {
    // A bigint wider than signed i64 would wrap silently at the boundary, not error (wasm.md).
    if (value < MIN_I64 || value > MAX_I64) {
      throw new SqliteMisuseError(
        `bigint out of int64 range: ${value}`,
        capi.SQLITE_MISUSE,
        capi.SQLITE_MISUSE,
      );
    }
    return capi.sqlite3_bind_int64(stmt, idx, value);
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return capi.sqlite3_bind_double(stmt, idx, value);
    // An integer-valued double can exceed i64 (e.g. 1e308); compare as bigint since numeric bounds lose precision near 2^63.
    const i64 = BigInt(value);
    if (i64 < MIN_I64 || i64 > MAX_I64) {
      throw new SqliteMisuseError(
        `number out of int64 range: ${value}`,
        capi.SQLITE_MISUSE,
        capi.SQLITE_MISUSE,
      );
    }
    return capi.sqlite3_bind_int64(stmt, idx, i64);
  }
  if (typeof value === "string") return bindText(sqlite3, stmt, idx, value);
  if (value instanceof Uint8Array) return bindBlob(sqlite3, stmt, idx, value);
  throw new SqliteMisuseError(
    `cannot bind value of type ${typeof value}`,
    capi.SQLITE_MISUSE,
    capi.SQLITE_MISUSE,
  );
};
