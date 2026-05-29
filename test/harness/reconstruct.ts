import type { FileImage, Op } from "./oplog.ts";
import { SECTOR_SIZE, touchedSectors } from "./oplog.ts";
import type { Rng } from "./rng.ts";

export const RECONSTRUCTIONS = [
  "drop-all-unsynced",
  "apply-all-unsynced",
  "scramble-tail",
  "scramble-arbitrary-sector",
] as const;

export type Reconstruction = (typeof RECONSTRUCTIONS)[number];

interface FileState {
  live: Uint8Array;
  liveSize: number;
  synced: Uint8Array;
  syncedSize: number;
  liveExists: boolean;
  syncedExists: boolean;
  zombie: Uint8Array;
  zombieSize: number;
  wasDeleted: boolean;
  dirtySectors: Set<number>;
}

const blank = (): FileState => ({
  live: new Uint8Array(0),
  liveSize: 0,
  synced: new Uint8Array(0),
  syncedSize: 0,
  liveExists: false,
  syncedExists: false,
  zombie: new Uint8Array(0),
  zombieSize: 0,
  wasDeleted: false,
  dirtySectors: new Set(),
});

const ensure = (states: Map<string, FileState>, file: string): FileState => {
  let s = states.get(file);
  if (!s) {
    s = blank();
    states.set(file, s);
  }
  return s;
};

const grow = (buf: Uint8Array, size: number, needed: number): Uint8Array => {
  if (needed <= buf.length) return buf;
  const next = new Uint8Array(Math.max(needed, buf.length * 2, SECTOR_SIZE));
  next.set(buf.subarray(0, size));
  return next;
};

const applyOps = (ops: readonly Op[], k: number): Map<string, FileState> => {
  const states = new Map<string, FileState>();
  for (let i = 0; i < k && i < ops.length; i++) {
    const op = ops[i];
    if (op === undefined) continue;
    const s = ensure(states, op.file);
    if (op.kind === "open-create") {
      s.liveExists = true;
      s.wasDeleted = false;
    } else if (op.kind === "write") {
      s.live = grow(s.live, s.liveSize, op.offset + op.bytes.length);
      s.live.set(op.bytes, op.offset);
      if (op.offset + op.bytes.length > s.liveSize) s.liveSize = op.offset + op.bytes.length;
      s.liveExists = true;
      for (const sec of touchedSectors(op.offset, op.bytes.length)) s.dirtySectors.add(sec);
    } else if (op.kind === "truncate") {
      s.liveSize = op.size;
      for (const sec of touchedSectors(Math.max(0, op.size - 1), 1)) s.dirtySectors.add(sec);
    } else if (op.kind === "delete") {
      if (s.syncedSize > 0 || s.syncedExists) {
        s.zombie = s.synced;
        s.zombieSize = s.syncedSize;
        s.wasDeleted = true;
      }
      s.liveExists = false;
      s.syncedExists = false;
      s.live = new Uint8Array(0);
      s.liveSize = 0;
      s.synced = new Uint8Array(0);
      s.syncedSize = 0;
      s.dirtySectors = new Set();
    } else if (op.kind === "sync" && op.real) {
      s.synced = s.live.slice(0, s.liveSize);
      s.syncedSize = s.liveSize;
      s.syncedExists = s.liveExists;
      s.zombie = s.synced;
      s.zombieSize = s.syncedSize;
      s.dirtySectors = new Set();
    }
  }
  return states;
};

const scrambleSector = (out: Uint8Array, sector: number, size: number, rng: Rng): void => {
  const start = sector * SECTOR_SIZE;
  const end = Math.min(start + SECTOR_SIZE, size);
  for (let i = start; i < end; i++) out[i] = rng.byte();
};

const reconstructBytes = (s: FileState, variant: Reconstruction, rng: Rng): Uint8Array => {
  if (variant === "drop-all-unsynced") return s.synced.slice(0, s.syncedSize);

  const size = s.liveSize;
  const out = new Uint8Array(size);
  out.set(s.live.subarray(0, size));
  if (variant === "apply-all-unsynced") return out;

  const sectors = [...s.dirtySectors];
  if (variant === "scramble-tail") {
    const lastDataSector = Math.floor(Math.max(0, size - 1) / SECTOR_SIZE);
    if (sectors.includes(lastDataSector)) scrambleSector(out, lastDataSector, size, rng);
    return out;
  }

  for (const sector of sectors) {
    const roll = rng.int(3);
    if (roll === 0) {
      const synStart = sector * SECTOR_SIZE;
      const synEnd = Math.min(synStart + SECTOR_SIZE, size, s.syncedSize);
      for (let i = synStart; i < synEnd; i++) out[i] = s.synced[i] ?? 0;
      for (let i = synEnd; i < Math.min(synStart + SECTOR_SIZE, size); i++) out[i] = 0;
    } else if (roll === 1) {
      scrambleSector(out, sector, size, rng);
    }
  }
  return out;
};

const dentryDropped = (variant: Reconstruction, rng: Rng): boolean =>
  variant === "drop-all-unsynced" ? true : variant === "apply-all-unsynced" ? false : rng.bool(0.5);

export interface ReconstructOptions {
  readonly dentryDurable: boolean;
}

const resolveFile = (
  s: FileState,
  variant: Reconstruction,
  rng: Rng,
  dentryDurable: boolean,
): FileImage | null => {
  if (s.liveExists) {
    if (s.syncedExists || dentryDurable) {
      return { bytes: reconstructBytes(s, variant, rng), exists: true };
    }
    return dentryDropped(variant, rng)
      ? null
      : { bytes: reconstructBytes(s, variant, rng), exists: true };
  }
  if (!dentryDurable && s.wasDeleted && dentryDropped(variant, rng)) {
    return { bytes: s.zombie.slice(0, s.zombieSize), exists: true };
  }
  return null;
};

export const reconstruct = (
  ops: readonly Op[],
  k: number,
  variant: Reconstruction,
  rng: Rng,
  opts: ReconstructOptions = { dentryDurable: true },
): Map<string, FileImage> => {
  const states = applyOps(ops, k);
  const out = new Map<string, FileImage>();
  for (const [file, s] of states) {
    const img = resolveFile(s, variant, rng, opts.dentryDurable);
    if (img) out.set(file, img);
  }
  return out;
};
