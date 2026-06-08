import type { Rng } from "../harness/rng.ts";
import { createRng } from "../harness/rng.ts";
import type { SqlValue } from "../../src/marshal.ts";
import type { FuzzOp, FuzzSeed } from "./model.ts";
import { fuzzValue, fuzzValues, overflowBigint } from "./values.ts";

const COLUMN_TYPES = ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC", ""] as const;
const COLUMN_CONSTRAINTS = [
  "",
  " NOT NULL",
  " UNIQUE",
  " DEFAULT 0",
  " CHECK(typeof(c)<>'real')",
] as const;
const PRAGMAS = [
  "PRAGMA integrity_check",
  "PRAGMA quick_check",
  "PRAGMA user_version=7",
  "PRAGMA cache_size=64",
  "PRAGMA foreign_keys=ON",
  "PRAGMA table_info(t)",
  "PRAGMA page_size",
] as const;

interface Table {
  readonly name: string;
  readonly columns: readonly string[];
}

interface GenState {
  readonly rng: Rng;
  readonly tables: Table[];
  txnDepth: number;
}

const ident = (state: GenState, prefix: string): string =>
  `${prefix}_${state.tables.length}_${state.rng.int(1000)}`;

const columnList = (rng: Rng): readonly string[] => {
  const n = 1 + rng.int(5);
  const cols: string[] = [];
  for (let i = 0; i < n; i++) cols.push(`c${i}`);
  return cols;
};

const createTableOp = (state: GenState): FuzzOp => {
  const name = ident(state, "tbl");
  const columns = columnList(state.rng);
  const defs = columns.map((c, i) => {
    const type = state.rng.pick(COLUMN_TYPES);
    const constraint = i === 0 && state.rng.bool(0.3)
      ? " PRIMARY KEY"
      : state.rng.pick(COLUMN_CONSTRAINTS).replaceAll("c)", `${c})`);
    return `${c}${type === "" ? "" : ` ${type}`}${constraint}`;
  });
  state.tables.push({ name, columns });
  return { kind: "exec", sql: `CREATE TABLE ${name}(${defs.join(", ")})` };
};

const pickTable = (state: GenState): Table | undefined =>
  state.tables.length === 0 ? undefined : state.rng.pick(state.tables);

const insertOp = (state: GenState): FuzzOp => {
  const table = pickTable(state);
  if (table === undefined) return createTableOp(state);
  const placeholders = table.columns.map(() => "?").join(", ");
  const useOverflow = state.rng.bool(0.05);
  const params: readonly SqlValue[] = useOverflow
    ? table.columns.map((_, i) => (i === 0 ? overflowBigint(state.rng) : fuzzValue(state.rng)))
    : fuzzValues(state.rng, table.columns.length);
  return {
    kind: "run",
    sql: `INSERT INTO ${table.name}(${table.columns.join(", ")}) VALUES (${placeholders})`,
    params,
  };
};

const updateOp = (state: GenState): FuzzOp => {
  const table = pickTable(state);
  if (table === undefined) return createTableOp(state);
  const col = state.rng.pick(table.columns);
  return {
    kind: "run",
    sql: `UPDATE ${table.name} SET ${col}=? WHERE rowid % ?=0`,
    params: [fuzzValue(state.rng), 1 + state.rng.int(7)],
  };
};

const deleteOp = (state: GenState): FuzzOp => {
  const table = pickTable(state);
  if (table === undefined) return createTableOp(state);
  return {
    kind: "run",
    sql: `DELETE FROM ${table.name} WHERE rowid > ?`,
    params: [state.rng.int(50)],
  };
};

const QUERY_METHODS = ["all", "get", "iter", "stream"] as const;

const selectOp = (state: GenState): FuzzOp => {
  const table = pickTable(state);
  const method = state.rng.pick(QUERY_METHODS);
  if (table === undefined) {
    return {
      kind: "query",
      method,
      sql: "SELECT ? AS a, ?+? AS b",
      params: fuzzValues(state.rng, 3),
    };
  }
  const second = pickTable(state) ?? table;
  const shape = state.rng.int(6);
  switch (shape) {
    case 0:
      return {
        kind: "query",
        method,
        sql: `SELECT * FROM ${table.name} ORDER BY 1 LIMIT ?`,
        params: [state.rng.int(20)],
      };
    case 1:
      return {
        kind: "query",
        method,
        sql: `SELECT count(*) AS n, max(${state.rng.pick(table.columns)}) AS m FROM ${table.name}`,
        params: [],
      };
    case 2:
      return {
        kind: "query",
        method,
        sql: `SELECT * FROM ${table.name} WHERE ${state.rng.pick(table.columns)}=? OR ${
          state.rng.pick(table.columns)
        } IS NULL`,
        params: [fuzzValue(state.rng)],
      };
    case 3:
      return {
        kind: "query",
        method,
        sql: `SELECT a.rowid FROM ${table.name} a JOIN ${second.name} b ON a.rowid=b.rowid LIMIT ?`,
        params: [state.rng.int(10)],
      };
    case 4:
      return {
        kind: "query",
        method,
        sql:
          `SELECT * FROM ${table.name} WHERE rowid IN (SELECT rowid FROM ${second.name} WHERE rowid < ?)`,
        params: [state.rng.int(30)],
      };
    default:
      return {
        kind: "query",
        method,
        sql: `SELECT ${state.rng.pick(table.columns)}, group_concat(${
          state.rng.pick(table.columns)
        }) FROM ${table.name} GROUP BY ${state.rng.pick(table.columns)} HAVING count(*) > ?`,
        params: [state.rng.int(3)],
      };
  }
};

const pragmaOp = (state: GenState): FuzzOp => ({ kind: "exec", sql: state.rng.pick(PRAGMAS) });

type LeafGen = (state: GenState) => FuzzOp;

const LEAF_GENS: readonly LeafGen[] = [
  createTableOp,
  insertOp,
  insertOp,
  insertOp,
  updateOp,
  deleteOp,
  selectOp,
  selectOp,
  pragmaOp,
];

const TXN_OUTCOMES = ["commit", "rollback", "dispose", "throw"] as const;
const MAX_TXN_DEPTH = 4;

const leafOp = (state: GenState): FuzzOp => state.rng.pick(LEAF_GENS)(state);

const txnOp = (state: GenState): FuzzOp => {
  state.txnDepth++;
  const bodyLen = 1 + state.rng.int(4);
  const body: FuzzOp[] = [];
  for (let i = 0; i < bodyLen; i++) {
    body.push(state.txnDepth < MAX_TXN_DEPTH && state.rng.bool(0.3) ? txnOp(state) : leafOp(state));
  }
  state.txnDepth--;
  return { kind: "txn", outcome: state.rng.pick(TXN_OUTCOMES), body };
};

const nextOp = (state: GenState): FuzzOp =>
  state.txnDepth < MAX_TXN_DEPTH && state.rng.bool(0.25) ? txnOp(state) : leafOp(state);

export const generateSequence = (seed: FuzzSeed, length: number): readonly FuzzOp[] => {
  const state: GenState = { rng: createRng(seed), tables: [], txnDepth: 0 };
  const ops: FuzzOp[] = [createTableOp(state)];
  for (let i = 1; i < length; i++) ops.push(nextOp(state));
  return ops;
};
