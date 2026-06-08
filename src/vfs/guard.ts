import { isAbsolute, resolve } from "@std/path";
import type { Sqlite3 } from "../glue.ts";
import { isNotFound } from "./errors.ts";

/**
 * The outcome of canonicalizing a requested path and re-checking it against
 * Deno's own grant. `"granted"` is the only state the VFS may open.
 *
 * Deno 2.8.1 checks `--allow-read`/`--allow-write` against the *lexical* path
 * argument, then lets the kernel follow symlinks — a link node inside the grant
 * whose target escapes it is opened, landing I/O outside the granted prefix
 * (SEC-001). This guard does the canonicalize-then-recheck Deno omits: resolve
 * symlinks to the canonical target, then `querySync` (a query, never a request —
 * it never widens the grant) the access the open flags imply.
 *
 * - `"escaped"`: the canonical target is outside the grant (`querySync` reports a
 *   non-`granted` state for it even when the lexical path queries `granted`).
 * - `"parent-unreadable"`: canonicalization needs read on the path's components
 *   and that read grant is absent (`realPathSync` → `NotCapable`). This is the
 *   same parent-directory read capability DEC-008's directory fsync needs
 *   (ENH-002); the public boundary turns it into a message that names the grant.
 */
export type GuardResult =
  | { readonly kind: "granted" }
  | { readonly kind: "escaped"; readonly mode: Deno.PermissionState }
  | { readonly kind: "parent-unreadable" };

const GRANTED: GuardResult = { kind: "granted" };
const PARENT_UNREADABLE: GuardResult = { kind: "parent-unreadable" };

const splitTrailing = (path: string): { readonly dir: string; readonly base: string } => {
  const i = path.lastIndexOf("/");
  if (i < 0) return { dir: ".", base: path };
  if (i === 0) return { dir: "/", base: path.slice(1) };
  return { dir: path.slice(0, i), base: path.slice(i + 1) };
};

/**
 * Resolves a final path component that is itself a symlink, relative or absolute,
 * against its own directory. A dangling symlink (target absent) still resolves —
 * the point is to surface where a create would *land*, not whether it exists.
 */
const resolveFinalLink = (path: string, dir: string): string => {
  const target = Deno.readLinkSync(path);
  return isAbsolute(target) ? target : resolve(dir, target);
};

/**
 * The canonical absolute path a `Deno.openSync(path)` would actually touch, with
 * every symlink resolved — including a symlinked final component and a not-yet-
 * existing create target (whose parent dir is canonicalized, basename appended).
 * Throws `NotCapable` when the read grant needed to walk the path is missing.
 */
const canonicalize = (path: string): string => {
  let info: Deno.FileInfo;
  try {
    info = Deno.lstatSync(path);
  } catch (e) {
    if (!isNotFound(e)) throw e;
    // Create-path: the leaf does not exist. Canonicalize the parent (resolves a
    // symlinked directory component) and re-append the leaf name.
    const { dir, base } = splitTrailing(path);
    return resolve(Deno.realPathSync(dir), base);
  }
  if (!info.isSymlink) return Deno.realPathSync(path);
  // The leaf itself is a symlink. realPathSync would follow it, but a *dangling*
  // link target throws NotFound — resolve the link target lexically instead so a
  // dangling escape (e.g. G/link -> O/absent.db) is still caught.
  const { dir } = splitTrailing(path);
  return resolveFinalLink(path, dir);
};

const neededMode = (capi: Sqlite3["capi"], flags: number): Deno.PermissionName => {
  const write = (flags & capi.SQLITE_OPEN_READWRITE) !== 0 ||
    (flags & capi.SQLITE_OPEN_CREATE) !== 0;
  return write ? "write" : "read";
};

/**
 * Canonicalizes `path` and re-checks `mode` access against Deno's grant. Pure and
 * total: every failure becomes a `GuardResult`, never a throw — the VFS catches
 * across the C boundary, and the public boundary maps the discriminant to a typed
 * error. `querySync` only queries; the grant is never widened (`security.md`).
 *
 * Shared by every filesystem-touching VFS op so the canonical-grant check sits at
 * every door, not just `xOpen` (SEC-001, SEC-003): `xDelete`/`syncDir` pass
 * `"write"`, `xAccess` passes `"read"`.
 */
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
    // A path that cannot be canonicalized for any other reason is not openable;
    // treat it as escaped so the caller refuses rather than guesses.
    return { kind: "escaped", mode: "prompt" };
  }
  const state = Deno.permissions.querySync({ name: mode, path: canonical }).state;
  return state === "granted" ? GRANTED : { kind: "escaped", mode: state };
};

/** True iff the canonical target is inside the grant — the only state a VFS op may proceed on. */
export const isGranted = (result: GuardResult): boolean => result.kind === "granted";

/**
 * Canonicalizes `path` and re-checks the access the open `flags` imply against
 * Deno's grant — the `xOpen`/preflight entry point that derives read-vs-write
 * from the SQLITE_OPEN_* flags before delegating to `guardPath`.
 */
export const guardOpen = (
  sqlite3: Sqlite3,
  path: string,
  flags: number,
): GuardResult => guardPath(path, neededMode(sqlite3.capi, flags));
