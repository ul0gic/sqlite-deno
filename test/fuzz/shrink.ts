import type { FuzzMode, FuzzOp, FuzzSeed } from "./model.ts";
import { opLabel } from "./model.ts";
import type { OracleProperty } from "./oracle.ts";
import { OracleViolation } from "./oracle.ts";
import { runOps } from "./driver.ts";

export interface ShrinkResult {
  readonly seed: number;
  readonly mode: FuzzMode;
  readonly property: OracleProperty;
  readonly original: readonly FuzzOp[];
  readonly minimal: readonly FuzzOp[];
  readonly attempts: number;
}

/** Materializes the DB file a candidate runs against (e.g. a corrupt template); omit for empty. */
export type PreparePath = (path: string) => void | Promise<void>;

export interface ShrinkOptions {
  readonly prepare?: PreparePath;
}

const reproduces = async (
  dir: string,
  seed: FuzzSeed,
  mode: FuzzMode,
  ops: readonly FuzzOp[],
  property: OracleProperty,
  attempt: number,
  prepare?: PreparePath,
): Promise<boolean> => {
  if (ops.length === 0) return false;
  const path = `${dir}/shrink-${(seed >>> 0).toString(16)}-${mode}-${attempt}.db`;
  if (prepare) await prepare(path);
  try {
    await runOps(path, seed, mode, ops);
    return false;
  } catch (e) {
    // Only the *same* property counts; a different violation is not a smaller witness.
    return e instanceof OracleViolation && e.property === property;
  }
};

const removeChunk = <T>(xs: readonly T[], start: number, len: number): readonly T[] => [
  ...xs.slice(0, start),
  ...xs.slice(start + len),
];

export const shrinkSequence = async (
  dir: string,
  seed: FuzzSeed,
  mode: FuzzMode,
  original: readonly FuzzOp[],
  property: OracleProperty,
  opts: ShrinkOptions = {},
): Promise<ShrinkResult> => {
  const { prepare } = opts;
  let attempts = 0;
  let current = original;

  for (let n = current.length; n > 1; n--) {
    attempts++;
    const prefix = current.slice(0, n - 1);
    if (await reproduces(dir, seed, mode, prefix, property, attempts, prepare)) current = prefix;
    else break;
  }

  let granularity = Math.max(1, Math.floor(current.length / 2));
  while (granularity >= 1) {
    let deletedSomething = false;
    let start = 0;
    while (start < current.length) {
      const len = Math.min(granularity, current.length - start);
      const candidate = removeChunk(current, start, len);
      attempts++;
      if (await reproduces(dir, seed, mode, candidate, property, attempts, prepare)) {
        current = candidate;
        deletedSomething = true;
      } else {
        start += len;
      }
    }
    if (!deletedSomething) granularity = Math.floor(granularity / 2);
  }

  return { seed, mode, property, original, minimal: current, attempts };
};

export const formatMinimal = (result: ShrinkResult): string => {
  const header =
    `seed=0x${(result.seed >>> 0).toString(16)} mode=${result.mode} property=${result.property} ` +
    `minimal=${result.minimal.length}/${result.original.length} ops (attempts=${result.attempts})`;
  const body = result.minimal.map((op, i) => `  [${i}] ${opLabel(op)}`).join("\n");
  return `${header}\n${body}`;
};
