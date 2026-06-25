import type { Rng } from "./rng.ts";
import { createRng } from "./rng.ts";
import { fuzzValue } from "../fuzz/values.ts";
import type { Cell, Row } from "./freeform-model.ts";

export interface TableSchema {
  readonly name: string;
  readonly columns: readonly string[];
}

export interface GeneratedSchema {
  readonly tables: readonly TableSchema[];
  readonly ddl: readonly string[];
}

export type FreeFormOp =
  | { readonly kind: "begin" }
  | { readonly kind: "commit" }
  | { readonly kind: "rollback" }
  | { readonly kind: "savepoint"; readonly name: string }
  | { readonly kind: "release"; readonly name: string }
  | { readonly kind: "rollback-to"; readonly name: string }
  | { readonly kind: "vacuum" }
  | {
    readonly kind: "insert";
    readonly table: string;
    readonly id: number;
    readonly cells: Row;
    readonly sql: string;
  }
  | {
    readonly kind: "update";
    readonly table: string;
    readonly id: number;
    readonly cells: Row;
    readonly sql: string;
  }
  | { readonly kind: "delete"; readonly table: string; readonly id: number; readonly sql: string };

export interface GeneratedWorkload {
  readonly schema: GeneratedSchema;
  readonly ops: readonly FreeFormOp[];
}

export interface SchemaShape {
  readonly tables: number;
  readonly txns: number;
  readonly maxOpsPerTxn: number;
  readonly savepoints: boolean;
}

export const CI_SHAPE: SchemaShape = { tables: 2, txns: 5, maxOpsPerTxn: 4, savepoints: true };

const buildSchema = (rng: Rng, tableCount: number): GeneratedSchema => {
  const tables: TableSchema[] = [];
  const ddl: string[] = [];
  for (let t = 0; t < tableCount; t++) {
    const name = `t${t}`;
    const colCount = 1 + rng.int(4);
    const columns: string[] = [];
    for (let c = 0; c < colCount; c++) columns.push(`c${c}`);
    tables.push({ name, columns });
    // Columns are declared BLOB-affinity (typeless): SQLite then stores exactly
    // what is bound with no INTEGER/REAL/TEXT coercion, so the reference model's
    // bound cells equal the read-back cells and the exact-equality oracle is sound.
    const colsDdl = columns.map((c) => `${c} BLOB`).join(", ");
    ddl.push(`CREATE TABLE ${name}(id INTEGER PRIMARY KEY, ${colsDdl})`);
  }
  return { tables, ddl };
};

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_I64 = 2n ** 63n - 1n;
const MIN_I64 = -(2n ** 63n);

/**
 * The public bind path (`marshal.bindValue`) rejects an integer-valued double
 * outside signed int64 (e.g. `Number.MAX_VALUE`), while `oo1.DB`'s bind path
 * accepts it — a binding-path divergence the marshal-misuse fuzz suite owns, not
 * this durability generator. Map such a value to a representative bigint so both
 * drivers store the SAME cell and the lockstep model stays sound; the i64
 * boundaries are still exercised via the bigint arm of `fuzzValue`.
 */
const bindable = (c: Cell): Cell => {
  if (typeof c !== "number" || !Number.isInteger(c)) return c;
  const i64 = BigInt(c);
  if (i64 >= MIN_I64 && i64 <= MAX_I64) return c;
  return c < 0 ? -MAX_SAFE : MAX_SAFE;
};

const cells = (rng: Rng, n: number): Row => {
  const out: Cell[] = [];
  for (let i = 0; i < n; i++) out.push(bindable(fuzzValue(rng)));
  return out;
};

const insertSql = (table: string, columns: readonly string[]): string => {
  const cols = ["id", ...columns].join(", ");
  const ph = ["?", ...columns.map(() => "?")].join(", ");
  return `INSERT OR REPLACE INTO ${table}(${cols}) VALUES (${ph})`;
};

const updateSql = (table: string, columns: readonly string[]): string => {
  const sets = columns.map((c) => `${c}=?`).join(", ");
  return `UPDATE ${table} SET ${sets} WHERE id=?`;
};

interface LiveId {
  ids: Set<number>;
  next: number;
}

const pickExisting = (rng: Rng, live: LiveId): number | undefined => {
  if (live.ids.size === 0) return undefined;
  const arr = [...live.ids];
  return arr[rng.int(arr.length)];
};

const mutationOp = (
  rng: Rng,
  schema: GeneratedSchema,
  liveByTable: Map<string, LiveId>,
): FreeFormOp => {
  const table = schema.tables[rng.int(schema.tables.length)];
  if (table === undefined) throw new Error("no table");
  const live = liveByTable.get(table.name);
  if (live === undefined) throw new Error(`no live tracker for ${table.name}`);
  const roll = rng.int(5);
  if (roll <= 2 || live.ids.size === 0) {
    const id = live.next++;
    live.ids.add(id);
    return {
      kind: "insert",
      table: table.name,
      id,
      cells: cells(rng, table.columns.length),
      sql: insertSql(table.name, table.columns),
    };
  }
  const id = pickExisting(rng, live);
  if (id === undefined) throw new Error("no existing id");
  if (roll === 3) {
    return {
      kind: "update",
      table: table.name,
      id,
      cells: cells(rng, table.columns.length),
      sql: updateSql(table.name, table.columns),
    };
  }
  live.ids.delete(id);
  return { kind: "delete", table: table.name, id, sql: `DELETE FROM ${table.name} WHERE id=?` };
};

export const generateWorkload = (seed: number, shape: SchemaShape): GeneratedWorkload => {
  const rng = createRng(seed);
  const schema = buildSchema(rng, shape.tables);
  const liveByTable = new Map<string, LiveId>();
  for (const t of schema.tables) liveByTable.set(t.name, { ids: new Set(), next: 1 });
  const committedLive = new Map<string, LiveId>();
  for (const t of schema.tables) committedLive.set(t.name, { ids: new Set(), next: 1 });

  const ops: FreeFormOp[] = [];
  let spDepth = 0;
  for (let t = 0; t < shape.txns; t++) {
    if (t > 0 && rng.bool(0.25)) ops.push({ kind: "vacuum" });
    ops.push({ kind: "begin" });
    const n = 1 + rng.int(shape.maxOpsPerTxn);
    for (let i = 0; i < n; i++) {
      const roll = shape.savepoints ? rng.int(10) : 9;
      if (roll < 2) {
        spDepth++;
        ops.push({ kind: "savepoint", name: `sp${spDepth}` });
      } else if (roll < 4 && spDepth > 0) {
        const name = `sp${spDepth}`;
        if (rng.bool(0.5)) ops.push({ kind: "rollback-to", name });
        else {
          ops.push({ kind: "release", name });
          spDepth--;
        }
      } else {
        ops.push(mutationOp(rng, schema, liveByTable));
      }
    }
    while (spDepth > 0) {
      ops.push({ kind: "release", name: `sp${spDepth}` });
      spDepth--;
    }
    if (rng.bool(0.15)) {
      ops.push({ kind: "rollback" });
      for (const [name, c] of committedLive) {
        const l = liveByTable.get(name);
        if (l) {
          l.ids = new Set(c.ids);
          l.next = c.next;
        }
      }
    } else {
      ops.push({ kind: "commit" });
      for (const [name, l] of liveByTable) {
        const c = committedLive.get(name);
        if (c) {
          c.ids.clear();
          for (const id of l.ids) c.ids.add(id);
          c.next = l.next;
        }
      }
    }
  }
  return { schema, ops };
};
