export type OracleProperty = "no-abort" | "integrity" | "usable" | "dispose";

/** Carries the seed so a failure replays deterministically: re-run that seed to reproduce. */
export class OracleViolation extends Error {
  override readonly name = "OracleViolation";
  readonly property: OracleProperty;
  readonly seed: number;

  constructor(property: OracleProperty, seed: number, detail: string) {
    super(`[seed=0x${(seed >>> 0).toString(16)}] ${property}: ${detail}`);
    this.property = property;
    this.seed = seed;
  }
}
