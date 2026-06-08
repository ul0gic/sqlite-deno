import type { Sqlite3 } from "./glue.ts";
import type { StmtPtr } from "./wasm/ptr.ts";
import { SqliteMisuseError } from "./errors.ts";

/**
 * The closed set of values that cross the binding boundary in either direction.
 * SQLite INTEGER is 64-bit: a value that fits exactly in a JS `number` (within
 * ±`Number.MAX_SAFE_INTEGER`) reads back as `number`, anything wider as `bigint`
 * — always exact, never truncated (see `wasm.md` i64 policy).
 */
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

/**
 * Narrows a 64-bit integer to `number` when it round-trips exactly, else keeps
 * the `bigint`. The shared widening rule for column reads and `lastInsertRowid`.
 */
export const narrowInt = (v: bigint): number | bigint =>
  v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : v;

/**
 * Reads column `col` of the current row by its SQLite datatype. A BLOB is copied
 * out of wasm linear memory exactly once here: the engine owns those bytes only
 * until the next `sqlite3_*` call, so the slice must happen before control
 * returns. The heap view is taken and dropped in the same statement — it detaches
 * if the heap grows (`wasm.md`).
 */
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
      // Unreachable by design: SQLite's column type is one of the five above. A
      // throw surfaces any future code on our side instead of masking it as NULL;
      // `readColumn` runs on our side, so this never throws into C (`wasm.md`).
      throw new SqliteMisuseError(
        `unexpected SQLite column type: ${type}`,
        capi.SQLITE_MISUSE,
        capi.SQLITE_MISUSE,
      );
  }
};

/**
 * Binds a string by allocating its own C-string in wasm memory and handing the
 * binder a pointer, then freeing on every path. The pointer route is deliberate:
 * the upstream `sqlite3_bind_text` value path is broken (it references an
 * undefined `pMem` for a JS string), and only the `wasm.isPtr` branch is sound.
 * `SQLITE_TRANSIENT` makes SQLite copy before we free.
 */
const bindText = (sqlite3: Sqlite3, stmt: StmtPtr, idx: number, value: string): number => {
  const { capi, wasm } = sqlite3;
  const [ptr, n] = wasm.allocCString(value, true);
  try {
    return capi.sqlite3_bind_text(stmt, idx, ptr, n, capi.SQLITE_TRANSIENT);
  } finally {
    wasm.dealloc(ptr);
  }
};

/**
 * Binds a blob via a self-owned wasm allocation, copying the bytes in exactly
 * once. The heap view is taken only after `alloc` (the last call that can grow
 * and detach the buffer) and dropped immediately. `SQLITE_TRANSIENT` makes
 * SQLite copy before the `finally` frees the allocation.
 */
const bindBlob = (sqlite3: Sqlite3, stmt: StmtPtr, idx: number, value: Uint8Array): number => {
  const { capi, wasm } = sqlite3;
  const n = value.length;
  // A non-null pointer is required even for an empty blob: a null pointer binds
  // SQL NULL, not a zero-length blob. Allocate at least one byte to keep the
  // pointer non-null while passing the true length.
  const ptr = wasm.alloc(n === 0 ? 1 : n);
  try {
    if (n > 0) wasm.heap8u().set(value, ptr);
    return capi.sqlite3_bind_blob(stmt, idx, ptr, n, capi.SQLITE_TRANSIENT);
  } finally {
    wasm.dealloc(ptr);
  }
};

/**
 * Binds one parameter at 1-based index `idx`. `value` is `unknown` because the
 * caller's params are untrusted input (`security.md`): the supported shapes are
 * validated here and anything else is a typed misuse, never a silent coercion. A
 * `number` that is an exact integer binds as i64 to avoid the float round-trip.
 * Text and blob payloads are marshaled and freed here (see `bindText`/`bindBlob`).
 * Returns the SQLite result code; the caller maps it.
 */
export const bindValue = (
  sqlite3: Sqlite3,
  stmt: StmtPtr,
  idx: number,
  value: unknown,
): number => {
  const { capi } = sqlite3;
  if (value === null) {
    // The upstream binder wraps `sqlite3_bind_null` with a void return, so it
    // yields `undefined` rather than the rc; a valid index never fails, so we
    // report success directly.
    capi.sqlite3_bind_null(stmt, idx);
    return capi.SQLITE_OK;
  }
  if (typeof value === "bigint") {
    // `sqlite3_bind_int64` takes a signed 64-bit C integer; a wider bigint would
    // wrap silently in the boundary truncation rather than error (`wasm.md`).
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
    return Number.isInteger(value)
      ? capi.sqlite3_bind_int64(stmt, idx, BigInt(value))
      : capi.sqlite3_bind_double(stmt, idx, value);
  }
  if (typeof value === "string") return bindText(sqlite3, stmt, idx, value);
  if (value instanceof Uint8Array) return bindBlob(sqlite3, stmt, idx, value);
  throw new SqliteMisuseError(
    `cannot bind value of type ${typeof value}`,
    capi.SQLITE_MISUSE,
    capi.SQLITE_MISUSE,
  );
};
