import { dirname, fromFileUrl, join } from "@std/path";

/**
 * DEC-012 provenance: transiently re-fetch the pinned npm tarball, verify its shasum, and
 * byte-compare to committed src/wasm/. Network is audit-only — never at install or runtime.
 */

const REGISTRY = "https://registry.npmjs.org";

type Pin = {
  readonly npmPackage: string;
  readonly version: string;
  readonly tarballSha1: string;
  readonly wasmSha256: string;
  readonly mjsSha256: string;
  readonly tarballWasmPath: string;
  readonly tarballMjsPath: string;
  readonly vendoredWasm: string;
  readonly vendoredMjs: string;
};

/** A provenance check failed — the committed bytes are not the pinned official release. */
export class ProvenanceError extends Error {
  override readonly name = "ProvenanceError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const REQUIRED_KEYS = [
  "NPM_PACKAGE",
  "VERSION",
  "TARBALL_SHA1",
  "WASM_SHA256",
  "MJS_SHA256",
  "TARBALL_WASM_PATH",
  "TARBALL_MJS_PATH",
  "VENDORED_WASM",
  "VENDORED_MJS",
] as const;

const parsePin = (text: string): Pin => {
  const kv = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) throw new ProvenanceError(`build/sqlite-version: malformed line: ${raw}`);
    kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  for (const key of REQUIRED_KEYS) {
    if (!kv.has(key)) throw new ProvenanceError(`build/sqlite-version: missing key ${key}`);
  }
  const get = (key: (typeof REQUIRED_KEYS)[number]): string => {
    const v = kv.get(key);
    if (v === undefined || v === "") {
      throw new ProvenanceError(`build/sqlite-version: empty value for ${key}`);
    }
    return v;
  };
  return {
    npmPackage: get("NPM_PACKAGE"),
    version: get("VERSION"),
    tarballSha1: get("TARBALL_SHA1"),
    wasmSha256: get("WASM_SHA256"),
    mjsSha256: get("MJS_SHA256"),
    tarballWasmPath: get("TARBALL_WASM_PATH"),
    tarballMjsPath: get("TARBALL_MJS_PATH"),
    vendoredWasm: get("VENDORED_WASM"),
    vendoredMjs: get("VENDORED_MJS"),
  };
};

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

const digestHex = async (
  algo: "SHA-1" | "SHA-256",
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> => toHex(await crypto.subtle.digest(algo, bytes));

const gunzip = async (gz: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => {
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const ustarName = (block: Uint8Array): string => {
  const dec = new TextDecoder();
  const name = dec.decode(block.subarray(0, 100)).replace(/\0.*$/, "");
  const prefix = dec.decode(block.subarray(345, 500)).replace(/\0.*$/, "");
  return prefix === "" ? name : `${prefix}/${name}`;
};

const octal = (block: Uint8Array, off: number, len: number): number => {
  const s = new TextDecoder().decode(block.subarray(off, off + len)).replace(/[\0 ]+$/, "").trim();
  return s === "" ? 0 : parseInt(s, 8);
};

// The npm tarball is plain ustar; read only the wanted regular-file entries.
const untarSelect = (tar: Uint8Array, wanted: ReadonlySet<string>): Map<string, Uint8Array> => {
  const out = new Map<string, Uint8Array>();
  const BLOCK = 512;
  let pos = 0;
  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK);
    pos += BLOCK;
    let empty = true;
    for (const byte of header) {
      if (byte !== 0) {
        empty = false;
        break;
      }
    }
    if (empty) break;
    const name = ustarName(header);
    const size = octal(header, 124, 12);
    const typeFlag = header[156];
    const dataBlocks = Math.ceil(size / BLOCK) * BLOCK;
    const isRegular = typeFlag === 0x30 || typeFlag === 0x00;
    if (isRegular && wanted.has(name)) out.set(name, tar.subarray(pos, pos + size));
    pos += dataBlocks;
  }
  return out;
};

const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let idx = 0; idx < a.length; idx++) diff |= (a[idx] ?? 0) ^ (b[idx] ?? 0);
  return diff === 0;
};

const writeLine = async (sink: WritableStreamDefaultWriter<Uint8Array>, line: string) => {
  await sink.write(new TextEncoder().encode(`${line}\n`));
};

type CheckResult = {
  readonly label: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
};

const verifyFile = async (
  label: string,
  extracted: Uint8Array | undefined,
  tarPath: string,
  committedPath: string,
  expectedSha256: string,
): Promise<CheckResult> => {
  if (extracted === undefined) {
    throw new ProvenanceError(`tarball is missing the expected entry ${tarPath}`);
  }
  const committed = await Deno.readFile(committedPath);
  if (!constantTimeEqual(extracted, committed)) {
    throw new ProvenanceError(
      `${label}: committed ${committedPath} does not byte-match the pinned tarball's ${tarPath} ` +
        `(committed ${committed.length} bytes, tarball ${extracted.length} bytes)`,
    );
  }
  const sha256 = await digestHex("SHA-256", committed);
  if (sha256 !== expectedSha256) {
    throw new ProvenanceError(
      `${label}: sha256 mismatch — expected ${expectedSha256}, got ${sha256}`,
    );
  }
  return { label, path: committedPath, bytes: committed.length, sha256 };
};

export const verifyVendor = async (root: string): Promise<readonly CheckResult[]> => {
  const pin = parsePin(await Deno.readTextFile(join(root, "build", "sqlite-version")));
  const url = `${REGISTRY}/${pin.npmPackage}/-/${
    pin.npmPackage.split("/").at(-1)
  }-${pin.version}.tgz`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new ProvenanceError(`fetch ${url} failed: HTTP ${res.status} ${res.statusText}`);
  }
  const tgz = new Uint8Array(await res.arrayBuffer());

  const tarballSha1 = await digestHex("SHA-1", tgz);
  if (tarballSha1 !== pin.tarballSha1) {
    throw new ProvenanceError(
      `tarball shasum mismatch — expected ${pin.tarballSha1}, got ${tarballSha1}. ` +
        `The pinned npm tarball is not the bytes we recorded.`,
    );
  }

  const tar = await gunzip(tgz);
  const wanted = new Set([pin.tarballWasmPath, pin.tarballMjsPath]);
  const files = untarSelect(tar, wanted);

  return [
    await verifyFile(
      "wasm",
      files.get(pin.tarballWasmPath),
      pin.tarballWasmPath,
      join(root, pin.vendoredWasm),
      pin.wasmSha256,
    ),
    await verifyFile(
      "mjs",
      files.get(pin.tarballMjsPath),
      pin.tarballMjsPath,
      join(root, pin.vendoredMjs),
      pin.mjsSha256,
    ),
  ];
};

const repoRoot = (): string => join(dirname(fromFileUrl(import.meta.url)), "..");

if (import.meta.main) {
  const out = Deno.stdout.writable.getWriter();
  const err = Deno.stderr.writable.getWriter();
  try {
    const results = await verifyVendor(repoRoot());
    for (const r of results) {
      await writeLine(out, `  ${r.label}: ${r.path} (${r.bytes} bytes) sha256 ${r.sha256} ✓`);
    }
    await writeLine(out, "AUTHENTIC: committed wasm byte-matches the pinned official release.");
    Deno.exit(0);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await writeLine(err, `NOT VERIFIED: ${reason}`);
    Deno.exit(1);
  } finally {
    out.releaseLock();
    err.releaseLock();
  }
}
