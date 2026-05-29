export interface Rng {
  readonly next: () => number;
  readonly int: (maxExclusive: number) => number;
  readonly byte: () => number;
  readonly pick: <T>(xs: readonly T[]) => T;
  readonly bool: (pTrue?: number) => boolean;
}

const mix = (seed: number): () => number => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const createRng = (seed: number): Rng => {
  const next = mix(seed);
  const int = (maxExclusive: number): number =>
    maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive);
  const byte = (): number => int(256);
  const pick = <T>(xs: readonly T[]): T => {
    const x = xs[int(xs.length)];
    if (x === undefined) throw new Error("pick from empty array");
    return x;
  };
  const bool = (pTrue = 0.5): boolean => next() < pTrue;
  return { next, int, byte, pick, bool };
};
