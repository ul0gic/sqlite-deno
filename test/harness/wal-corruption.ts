import type { Sqlite3 } from "../../src/glue.ts";
import type { CrashRecorder } from "./crash-vfs.ts";
import type { FileImage, Op } from "./oplog.ts";
import { createRng } from "./rng.ts";
import { runWalWorkload, type WalWorkloadSpec } from "./wal-workload.ts";
import { reconstructWal } from "./wal-reconstruct.ts";
import { corruptFramePayload, isWal, parseWal } from "./wal-format.ts";
import { verifyWalReconstruction } from "./wal-verify.ts";

export interface CorruptionPoint {
  readonly frameIndex: number;
  readonly integrityOk: boolean;
  readonly present: readonly number[];
  readonly droppedAnyCommitted: boolean;
}

export interface CorruptionResult {
  readonly issued: readonly number[];
  readonly nFrames: number;
  readonly points: readonly CorruptionPoint[];
}

/**
 * The crash index just before the connection's clean close checkpoints the
 * `-wal` into the main DB and deletes it. Reconstructing at the workload's final
 * op would yield a `-wal`-less image (clean close drains it); we want the fully
 * populated `-wal` so a mid-log frame is meaningful. This is the op index right
 * after the last `-wal` write, before any `-wal` delete/truncate-to-zero.
 */
const lastWalIntactIndex = (ops: readonly Op[]): number => {
  let last = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op === undefined) continue;
    if (op.kind === "write" && isWal(op.file)) last = i + 1;
    if ((op.kind === "delete" || (op.kind === "truncate" && op.size === 0)) && isWal(op.file)) {
      return last;
    }
  }
  return last;
};

const isStrictPrefix = (present: readonly number[], issued: readonly number[]): boolean => {
  for (let i = 0; i < present.length; i++) {
    if (present[i] !== issued[i]) return false;
  }
  return true;
};

/**
 * The WAL-specific negative control (DEC-010 §4 "negative control"): corrupt a
 * frame checksum in the *middle* of the log and confirm recovery stops there.
 * Because recovery discards the broken frame and everything after it, the
 * recovered value set MUST be a contiguous prefix of the issued sequence — if
 * the verifier ever reports a value whose commit frame is past the break, the
 * recovery (or the harness reading it) is lying. We return per-frame results so
 * the test can assert both the prefix property and that at least one corruption
 * actually drops a committed value (a vacuous all-survive run proves nothing).
 */
export const runMidLogCorruption = async (
  sqlite3: Sqlite3,
  recorder: CrashRecorder,
  dir: string,
  spec: WalWorkloadSpec,
  seed: number,
): Promise<CorruptionResult> => {
  const recorded = runWalWorkload(sqlite3, recorder, spec);
  const issued = recorded.commits.map((c) => c.value);
  const k = lastWalIntactIndex(recorded.ops);
  const clean = reconstructWal(
    recorded.ops,
    k,
    "apply-all-unsynced",
    "none",
    createRng(seed),
  );
  const walEntry = [...clean.image.entries()].find(([f]) => isWal(f));
  if (!walEntry) return { issued, nFrames: 0, points: [] };
  const [walFile, walImg] = walEntry;
  const layout = parseWal(walImg.bytes);
  if (!layout) return { issued, nFrames: 0, points: [] };

  const everIssued = new Set(issued);
  const points: CorruptionPoint[] = [];
  for (let f = 0; f < layout.frames.length; f++) {
    const corrupted = corruptFramePayload(walImg.bytes, layout, f, 50 + (f * 37) % layout.pageSize);
    const image = new Map<string, FileImage>(clean.image);
    image.set(walFile, { bytes: corrupted, exists: true });

    const result = await verifyWalReconstruction(
      sqlite3,
      dir,
      recorded.dbName,
      image,
      { mustBePresent: new Set(), mayBeAbsent: everIssued, everIssued },
    );
    const present = [...result.present].sort((a, b) => a - b);
    points.push({
      frameIndex: f,
      integrityOk: result.ok && !result.detail.startsWith("I1"),
      present,
      droppedAnyCommitted: present.length < issued.length,
    });
  }
  return { issued, nFrames: layout.frames.length, points };
};

export const corruptionViolations = (res: CorruptionResult): readonly string[] => {
  const out: string[] = [];
  for (const p of res.points) {
    if (!p.integrityOk) out.push(`frame ${p.frameIndex}: I1 failed after mid-log corruption`);
    if (!isStrictPrefix(p.present, res.issued)) {
      out.push(
        `frame ${p.frameIndex}: recovery surfaced a non-prefix set [${p.present}] from issued [${res.issued}] — a value from past the broken frame leaked`,
      );
    }
  }
  return out;
};

export const droppedAnyCommitted = (res: CorruptionResult): boolean =>
  res.points.some((p) => p.droppedAnyCommitted);
