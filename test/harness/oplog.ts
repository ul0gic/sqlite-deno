export const SECTOR_SIZE = 4096;

export type Op =
  | { readonly kind: "open-create"; readonly file: string }
  | {
    readonly kind: "write";
    readonly file: string;
    readonly offset: number;
    readonly bytes: Uint8Array;
  }
  | { readonly kind: "truncate"; readonly file: string; readonly size: number }
  | { readonly kind: "sync"; readonly file: string; readonly real: boolean }
  | { readonly kind: "delete"; readonly file: string };

export interface FileImage {
  readonly bytes: Uint8Array;
  readonly exists: boolean;
}

export interface OpLog {
  readonly ops: readonly Op[];
  readonly commits: ReadonlyMap<number, number>;
}

export const isMutatingOp = (op: Op): boolean =>
  op.kind === "write" || op.kind === "truncate" || op.kind === "sync" || op.kind === "delete";

export const sectorOf = (offset: number): number => Math.floor(offset / SECTOR_SIZE);

export const touchedSectors = (offset: number, length: number): readonly number[] => {
  const first = sectorOf(offset);
  const last = sectorOf(offset + Math.max(1, length) - 1);
  const out: number[] = [];
  for (let s = first; s <= last; s++) out.push(s);
  return out;
};
