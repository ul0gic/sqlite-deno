import type { SqlValue } from "../../src/marshal.ts";
import type { Rng } from "./rng.ts";
import { createRng } from "./rng.ts";

export type ShapeStmt =
  | { readonly kind: "exec"; readonly sql: string }
  | { readonly kind: "run"; readonly sql: string; readonly params: readonly SqlValue[] };

export interface WorkloadPlan {
  readonly setup: readonly ShapeStmt[];
  readonly perTxn: (txnIndex: number) => readonly ShapeStmt[];
  readonly betweenTxn: (txnIndex: number) => readonly ShapeStmt[];
}

const HOSTILE_TEXT = [
  "",
  "x".repeat(2000),
  "héllo-\u{1F4A5}-\u{0000}\u{FFFD}",
  "'; DROP TABLE kv; --",
  "\u{0301}\u{0301}\u{0301}combining",
  "\t\n\r mixed ws ",
] as const;

const hostileBlob = (rng: Rng): Uint8Array => {
  const n = rng.int(2048);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.byte();
  return out;
};

const hostileValue = (rng: Rng): SqlValue => {
  const roll = rng.int(6);
  if (roll === 0) return null;
  if (roll === 1) return rng.pick(HOSTILE_TEXT);
  if (roll === 2) return hostileBlob(rng);
  if (roll === 3) return rng.int(1_000_000) - 500_000;
  if (roll === 4) return (rng.next() - 0.5) * 1e12;
  return BigInt(rng.int(1_000_000)) * 1_000_000_007n;
};

// Hostile second table mutated in the same txns that advance `kv`, widening the op
// space while `kv` stays the durable I2 witness the oracle reads back.
const auxName = "aux";

const auxValueRun = (rng: Rng): ShapeStmt => ({
  kind: "run",
  sql: `INSERT INTO ${auxName}(a, b, c) VALUES (?, ?, ?)`,
  params: [hostileValue(rng), hostileValue(rng), hostileValue(rng)],
});

const MUTATIONS: readonly ((rng: Rng) => ShapeStmt)[] = [
  auxValueRun,
  auxValueRun,
  (rng) => ({
    kind: "run",
    sql: `UPDATE ${auxName} SET b=? WHERE rowid % ?=0`,
    params: [hostileValue(rng), 1 + rng.int(5)],
  }),
  (rng) => ({
    kind: "run",
    sql: `DELETE FROM ${auxName} WHERE rowid > ?`,
    params: [rng.int(40)],
  }),
];

export const buildWorkloadPlan = (shapeSeed: number): WorkloadPlan => {
  const rng = createRng(shapeSeed);
  const setup: readonly ShapeStmt[] = [
    { kind: "exec", sql: `CREATE TABLE ${auxName}(a, b, c)` },
    { kind: "exec", sql: `CREATE INDEX ${auxName}_b ON ${auxName}(b)` },
  ];
  const perTxn = (_txnIndex: number): readonly ShapeStmt[] => {
    const out: ShapeStmt[] = [];
    const n = 1 + rng.int(4);
    for (let i = 0; i < n; i++) out.push(rng.pick(MUTATIONS)(rng));
    return out;
  };
  const betweenTxn = (txnIndex: number): readonly ShapeStmt[] =>
    txnIndex > 0 && rng.bool(0.25) ? [{ kind: "exec", sql: "VACUUM" }] : [];
  return { setup, perTxn, betweenTxn };
};
