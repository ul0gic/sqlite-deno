import type { FileImage, Op } from "./oplog.ts";
import { SECTOR_SIZE } from "./oplog.ts";
import type { Rng } from "./rng.ts";
import { reconstruct, type Reconstruction, RECONSTRUCTIONS } from "./reconstruct.ts";
import { isWal, parseWal, truncateAtFrame, truncateMidFrame } from "./wal-format.ts";

export const WAL_TAIL_MUTATIONS = [
  "none",
  "truncate-at-frame-boundary",
  "torn-final-frame",
] as const;

export type WalTailMutation = (typeof WAL_TAIL_MUTATIONS)[number];

export const WAL_VARIANTS: readonly { content: Reconstruction; tail: WalTailMutation }[] = [
  { content: "drop-all-unsynced", tail: "none" },
  { content: "apply-all-unsynced", tail: "none" },
  { content: "scramble-tail", tail: "none" },
  { content: "scramble-arbitrary-sector", tail: "none" },
  { content: "apply-all-unsynced", tail: "truncate-at-frame-boundary" },
  { content: "apply-all-unsynced", tail: "torn-final-frame" },
  { content: "drop-all-unsynced", tail: "truncate-at-frame-boundary" },
  { content: "scramble-arbitrary-sector", tail: "torn-final-frame" },
] as const;

const scrambleLastSector = (bytes: Uint8Array, syncedSize: number, rng: Rng): Uint8Array => {
  if (bytes.byteLength === 0) return bytes;
  const lastSectorStart = Math.floor((bytes.byteLength - 1) / SECTOR_SIZE) * SECTOR_SIZE;
  if (lastSectorStart < syncedSize) return bytes;
  const out = bytes.slice();
  for (let i = lastSectorStart; i < out.byteLength; i++) out[i] = rng.byte();
  return out;
};

/**
 * The byte length of the `-wal` covered by a successful `xSync` at crash index
 * `k` — the size at the last real `-wal` `xSync` at or before `k`. DEC-007 §1:
 * synced data is durable and MUST survive, so a tail mutation may only ever
 * drop/scramble bytes beyond this point. A truncation or tear below it would
 * model a broken disk, not power loss — the harness must never do it.
 */
const syncedWalSize = (ops: readonly Op[], walFile: string, k: number): number => {
  let liveSize = 0;
  let synced = 0;
  for (let i = 0; i < k && i < ops.length; i++) {
    const op = ops[i];
    if (op === undefined || (op.kind !== "dir-sync" && op.file !== walFile)) continue;
    if (op.kind === "write") liveSize = Math.max(liveSize, op.offset + op.bytes.length);
    else if (op.kind === "truncate") liveSize = op.size;
    else if (op.kind === "sync" && op.real) synced = liveSize;
    else if (op.kind === "delete") {
      liveSize = 0;
      synced = 0;
    }
  }
  return synced;
};

/**
 * Apply a WAL-specific tail mutation to the `-wal` image — the cases DEC-010 §2
 * names beyond the generic content power-loss: a `-wal` cut at a frame boundary
 * (an append-log torn between frames) and a torn final frame (its last sector
 * scrambled). Both must recover to a consistent committed prefix (I1) and never
 * surface a partial transaction (I2). When there are no whole frames, the
 * mutation is a no-op — there is nothing to tear.
 */
const mutateWalTail = (
  bytes: Uint8Array,
  mutation: WalTailMutation,
  syncedSize: number,
  rng: Rng,
): Uint8Array => {
  if (mutation === "none") return bytes;
  const layout = parseWal(bytes);
  if (!layout || layout.frames.length === 0) return bytes;
  if (mutation === "torn-final-frame") return scrambleLastSector(bytes, syncedSize, rng);

  const lastFrame = layout.frames.length - 1;
  const firstUnsynced = layout.frames.findIndex((f) => f.headerOffset >= syncedSize);
  if (firstUnsynced < 0) return bytes;
  const keepThrough = firstUnsynced + rng.int(lastFrame - firstUnsynced + 1);
  if (rng.bool(0.5)) return truncateAtFrame(bytes, layout, keepThrough - 1);
  const tearFrame = Math.max(firstUnsynced, lastFrame);
  return truncateMidFrame(bytes, layout, tearFrame, 24 + rng.int(layout.pageSize));
};

export interface WalReconstructResult {
  readonly image: Map<string, FileImage>;
  readonly hasShm: boolean;
}

/**
 * Reconstruct a post-crash {main DB, `-wal`} image: the generic content
 * power-loss (`reconstruct`) plus a `-wal`-specific tail mutation. Mode-2 WAL
 * never writes a `-shm`, so the image must carry none; `hasShm` is reported so
 * the sweep can assert I3 — a stray `-shm` is never present, and recovery
 * rebuilds the heap wal-index from the `-wal` alone.
 */
export const reconstructWal = (
  ops: readonly Op[],
  k: number,
  content: Reconstruction,
  tail: WalTailMutation,
  rng: Rng,
): WalReconstructResult => {
  const base = reconstruct(ops, k, content, rng, { dentryDurable: true });
  const image = new Map<string, FileImage>();
  let hasShm = false;
  for (const [file, img] of base) {
    if (file.endsWith("-shm")) {
      hasShm = true;
      continue;
    }
    if (isWal(file) && img.exists) {
      const synced = syncedWalSize(ops, file, k);
      image.set(file, { bytes: mutateWalTail(img.bytes, tail, synced, rng), exists: true });
      continue;
    }
    image.set(file, img);
  }
  return { image, hasShm };
};

export { RECONSTRUCTIONS };
