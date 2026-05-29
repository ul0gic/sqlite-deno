const WAL_HEADER_SIZE = 32;
const FRAME_HEADER_SIZE = 24;
const WAL_MAGIC_BE = 0x377f0682;
const WAL_MAGIC_LE = 0x377f0683;

const PAGE_SIZE_OFFSET = 8;
const FRAME_DB_SIZE_OFFSET = 4;

export const isWal = (file: string): boolean => file.endsWith("-wal");

export interface WalFrame {
  readonly index: number;
  readonly headerOffset: number;
  readonly payloadOffset: number;
  readonly endOffset: number;
  readonly dbSizeAfter: number;
  readonly isCommit: boolean;
}

export interface WalLayout {
  readonly pageSize: number;
  readonly frameSize: number;
  readonly frames: readonly WalFrame[];
  readonly salt1: number;
  readonly salt2: number;
}

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * A `-wal` is parseable iff it carries a valid 32-byte header magic and a
 * power-of-two page size whose frame slots fit the file exactly. A torn or
 * truncated tail leaves a fractional final frame; we report only whole frames
 * (recovery discards a fractional tail, DEC-010 §1.3), so a fractional tail is
 * not a parse failure — it is simply not counted as a frame.
 */
export const parseWal = (bytes: Uint8Array): WalLayout | null => {
  if (bytes.byteLength < WAL_HEADER_SIZE) return null;
  const dv = viewOf(bytes);
  const magic = dv.getUint32(0, false);
  if (magic !== WAL_MAGIC_BE && magic !== WAL_MAGIC_LE) return null;
  const pageSize = dv.getUint32(PAGE_SIZE_OFFSET, false);
  if (pageSize <= 0 || (pageSize & (pageSize - 1)) !== 0) return null;

  const frameSize = FRAME_HEADER_SIZE + pageSize;
  const salt1 = dv.getUint32(16, false);
  const salt2 = dv.getUint32(20, false);
  const frames: WalFrame[] = [];
  let index = 0;
  let off = WAL_HEADER_SIZE;
  while (off + frameSize <= bytes.byteLength) {
    const dbSizeAfter = dv.getUint32(off + FRAME_DB_SIZE_OFFSET, false);
    frames.push({
      index,
      headerOffset: off,
      payloadOffset: off + FRAME_HEADER_SIZE,
      endOffset: off + frameSize,
      dbSizeAfter,
      isCommit: dbSizeAfter > 0,
    });
    index++;
    off += frameSize;
  }
  return { pageSize, frameSize, frames, salt1, salt2 };
};

export const frameBoundaryOffsets = (layout: WalLayout): readonly number[] => {
  const out = [WAL_HEADER_SIZE];
  for (const f of layout.frames) out.push(f.endOffset);
  return out;
};

export const commitFrames = (layout: WalLayout): readonly WalFrame[] =>
  layout.frames.filter((f) => f.isCommit);

export const truncateAtFrame = (
  bytes: Uint8Array,
  layout: WalLayout,
  frameIndex: number,
): Uint8Array => {
  const frame = layout.frames[frameIndex];
  const end = frame ? frame.endOffset : WAL_HEADER_SIZE;
  return bytes.slice(0, end);
};

export const truncateMidFrame = (
  bytes: Uint8Array,
  layout: WalLayout,
  frameIndex: number,
  withinFrame: number,
): Uint8Array => {
  const frame = layout.frames[frameIndex];
  if (!frame) return bytes.slice(0, WAL_HEADER_SIZE);
  const cut = Math.min(frame.headerOffset + withinFrame, frame.endOffset - 1);
  return bytes.slice(0, cut);
};

/**
 * Flip the high bit of one payload byte of a frame so its running checksum no
 * longer validates. DEC-010 §1.3: recovery stops at the first frame whose
 * checksum fails, discarding it and everything after. We never need to forge a
 * passing checksum — corrupting a byte reliably invalidates it, which is the
 * direction the mid-log negative control exercises.
 */
export const corruptFramePayload = (
  bytes: Uint8Array,
  layout: WalLayout,
  frameIndex: number,
  byteWithinPayload: number,
): Uint8Array => {
  const frame = layout.frames[frameIndex];
  if (!frame) return bytes;
  const out = bytes.slice();
  const at = frame.payloadOffset + (byteWithinPayload % layout.pageSize);
  const cur = out[at] ?? 0;
  out[at] = cur ^ 0xff;
  return out;
};
