import { basename, dirname, isAbsolute, resolve } from "@std/path";
import type { Sqlite3 } from "../glue.ts";
import { isNotFound } from "./errors.ts";

// Canonicalize-then-recheck Deno omits: it checks grants against the lexical path,
// then the kernel follows symlinks past the grant (SEC-001); `"granted"` is the only openable state.
export type GuardResult =
  | { readonly kind: "granted" }
  | { readonly kind: "escaped"; readonly mode: Deno.PermissionState }
  | { readonly kind: "parent-unreadable" };

const GRANTED: GuardResult = { kind: "granted" };
const PARENT_UNREADABLE: GuardResult = { kind: "parent-unreadable" };

// Resolves even a dangling link: surfaces where a create would land, not whether the target exists.
const resolveFinalLink = (path: string, dir: string): string => {
  const target = Deno.readLinkSync(path);
  return isAbsolute(target) ? target : resolve(dir, target);
};

// Split parent/leaf via @std/path so backslash/drive/UNC paths resolve right; a
// lastIndexOf("/") split canonicalized against cwd on Windows (BUG-007).
const canonicalize = (path: string): string => {
  let info: Deno.FileInfo;
  try {
    info = Deno.lstatSync(path);
  } catch (e) {
    if (!isNotFound(e)) throw e;
    // Create-path: leaf absent — canonicalize the parent, re-append the leaf.
    return resolve(Deno.realPathSync(dirname(path)), basename(path));
  }
  if (!info.isSymlink) return Deno.realPathSync(path);
  // realPathSync throws NotFound on a dangling leaf link; resolve lexically so a
  // dangling escape (G/link -> O/absent.db) is still caught.
  return resolveFinalLink(path, dirname(path));
};

const neededMode = (capi: Sqlite3["capi"], flags: number): Deno.PermissionName => {
  const write = (flags & capi.SQLITE_OPEN_READWRITE) !== 0 ||
    (flags & capi.SQLITE_OPEN_CREATE) !== 0;
  return write ? "write" : "read";
};

/** Canonicalizes `path` and re-checks `mode` against the grant; total — every failure
 * is a `GuardResult`, never a throw across the C boundary (SEC-001, SEC-003). */
export const guardPath = (
  path: string,
  mode: Deno.PermissionName,
): GuardResult => {
  let canonical: string;
  try {
    canonical = canonicalize(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotCapable || e instanceof Deno.errors.PermissionDenied) {
      return PARENT_UNREADABLE;
    }
    // Uncanonicalizable for any other reason: treat as escaped so the caller refuses.
    return { kind: "escaped", mode: "prompt" };
  }
  const state = Deno.permissions.querySync({ name: mode, path: canonical }).state;
  return state === "granted" ? GRANTED : { kind: "escaped", mode: state };
};

/** True iff the canonical target is inside the grant — the only state a VFS op may proceed on. */
export const isGranted = (result: GuardResult): boolean => result.kind === "granted";

/** The `xOpen`/preflight entry point: derives read-vs-write from the SQLITE_OPEN_* flags. */
export const guardOpen = (
  sqlite3: Sqlite3,
  path: string,
  flags: number,
): GuardResult => guardPath(path, neededMode(sqlite3.capi, flags));
