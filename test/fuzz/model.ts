import type { SqlValue } from "../../src/marshal.ts";

export type FuzzSeed = number & { readonly __brand: "FuzzSeed" };

export const asSeed = (n: number): FuzzSeed => (n >>> 0) as FuzzSeed;

export type FuzzMode = "rollback" | "wal";

export interface ExecOp {
  readonly kind: "exec";
  readonly sql: string;
}

export interface QueryOp {
  readonly kind: "query";
  readonly method: "all" | "get" | "iter" | "stream";
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

export interface RunOp {
  readonly kind: "run";
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

export interface TxnOp {
  readonly kind: "txn";
  readonly outcome: "commit" | "rollback" | "dispose" | "throw";
  readonly body: readonly FuzzOp[];
}

export type FuzzOp = ExecOp | QueryOp | RunOp | TxnOp;

export const opLabel = (op: FuzzOp): string => {
  switch (op.kind) {
    case "exec":
      return `exec ${op.sql}`;
    case "query":
      return `query.${op.method} ${op.sql} :: ${describeParams(op.params)}`;
    case "run":
      return `run ${op.sql} :: ${describeParams(op.params)}`;
    case "txn":
      return `txn[${op.outcome}](${op.body.map(opLabel).join("; ")})`;
    default:
      return assertNever(op);
  }
};

const describeParams = (params: readonly SqlValue[]): string =>
  `[${params.map(describeParam).join(", ")}]`;

const describeParam = (v: SqlValue): string => {
  if (v === null) return "null";
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "string") return JSON.stringify(v);
  if (v instanceof Uint8Array) return `blob(${v.length})`;
  return String(v);
};

const assertNever = (x: never): never => {
  throw new Error(`unreachable FuzzOp: ${JSON.stringify(x)}`);
};
