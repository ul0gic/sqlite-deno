import type { SqlValue } from "../../src/marshal.ts";

export type Cell = SqlValue;
export type Row = readonly Cell[];
export type TableState = ReadonlyMap<number, Row>;
export type DbState = ReadonlyMap<string, TableState>;

export interface CommitSnapshot {
  readonly opIndex: number;
  readonly state: DbState;
  // In flight at crash `k` iff beginOpIndex <= k < opIndex (commit point not yet
  // landed, so an unsynced reconstruction may roll it forward); VACUUM never qualifies.
  readonly beginOpIndex: number;
  walSyncCoveredOpIndex: number;
}

const cloneCell = (c: Cell): Cell => (c instanceof Uint8Array ? c.slice() : c);

const cloneRow = (r: Row): Row => r.map(cloneCell);

const cloneTable = (t: TableState): Map<number, Row> => {
  const out = new Map<number, Row>();
  for (const [id, row] of t) out.set(id, cloneRow(row));
  return out;
};

const cloneDb = (db: DbState): Map<string, Map<number, Row>> => {
  const out = new Map<string, Map<number, Row>>();
  for (const [name, t] of db) out.set(name, cloneTable(t));
  return out;
};

const numericKey = (n: number | bigint): string => {
  if (typeof n === "bigint") return n.toString();
  if (Number.isInteger(n)) return BigInt(n).toString();
  return n.toString();
};

export const cellsEqual = (a: Cell, b: Cell): boolean => {
  if (a === null || b === null) return a === b;
  const aNum = typeof a === "number" || typeof a === "bigint";
  const bNum = typeof b === "number" || typeof b === "bigint";
  if (aNum && bNum) return numericKey(a) === numericKey(b);
  if (aNum !== bNum) return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return a === b;
};

const rowsEqual = (a: Row, b: Row): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (!cellsEqual(x, y)) return false;
  }
  return true;
};

export interface TableMismatch {
  readonly table: string;
  readonly detail: string;
}

const tableMismatch = (
  table: string,
  expected: TableState,
  actual: TableState,
): TableMismatch | null => {
  for (const [id, row] of expected) {
    const got = actual.get(id);
    if (got === undefined) return { table, detail: `missing committed row id=${id}` };
    if (!rowsEqual(row, got)) {
      return { table, detail: `row id=${id} mismatch: expected ${fmtRow(row)} got ${fmtRow(got)}` };
    }
  }
  for (const id of actual.keys()) {
    if (!expected.has(id)) return { table, detail: `phantom/resurrected row id=${id}` };
  }
  return null;
};

export const fmtCell = (c: Cell): string => {
  if (c === null) return "null";
  if (c instanceof Uint8Array) return `blob<${c.length}>`;
  if (typeof c === "bigint") return `${c}n`;
  if (typeof c === "string") return JSON.stringify(c.length > 24 ? `${c.slice(0, 24)}…` : c);
  return String(c);
};

export const fmtRow = (r: Row): string => `[${r.map(fmtCell).join(",")}]`;

// Exact set-equality, not subset: the witness is delete-bearing, so only exact
// equality catches resurrection of a deleted-committed row alongside loss/phantom.
export const stateMismatch = (expected: DbState, actual: DbState): TableMismatch | null => {
  for (const [name, table] of expected) {
    const got = actual.get(name) ?? new Map<number, Row>();
    const m = tableMismatch(name, table, got);
    if (m) return m;
  }
  for (const [name, table] of actual) {
    if (!expected.has(name)) {
      if (table.size > 0) return { table: name, detail: `phantom table with ${table.size} rows` };
    }
  }
  return null;
};

export interface ReferenceModel {
  readonly tables: readonly string[];
  readonly insert: (table: string, id: number, cells: Row) => void;
  readonly update: (table: string, id: number, cells: Row) => void;
  readonly del: (table: string, id: number) => void;
  readonly savepoint: () => void;
  readonly release: () => void;
  readonly rollbackTo: () => void;
  readonly begin: (opIndex: number) => void;
  readonly commit: (opIndex: number) => void;
  readonly rollback: () => void;
  readonly snapshots: () => readonly CommitSnapshot[];
  readonly hasRow: (table: string, id: number) => boolean;
}

export const createReferenceModel = (tableNames: readonly string[]): ReferenceModel => {
  const empty = (): Map<string, Map<number, Row>> => {
    const db = new Map<string, Map<number, Row>>();
    for (const name of tableNames) db.set(name, new Map());
    return db;
  };

  let committed = empty();
  let pending = empty();
  const savepoints: Map<string, Map<number, Row>>[] = [];
  const snapshots: CommitSnapshot[] = [];
  let beginOpIndex = 0;

  const tableOf = (name: string): Map<number, Row> => {
    const t = pending.get(name);
    if (t === undefined) throw new Error(`unknown table ${name}`);
    return t;
  };

  return {
    tables: tableNames,
    insert: (table, id, cells) => tableOf(table).set(id, cloneRow(cells)),
    update: (table, id, cells) => {
      const t = tableOf(table);
      if (t.has(id)) t.set(id, cloneRow(cells));
    },
    del: (table, id) => tableOf(table).delete(id),
    savepoint: () => savepoints.push(cloneDb(pending)),
    release: () => void savepoints.pop(),
    rollbackTo: () => {
      const marker = savepoints[savepoints.length - 1];
      if (marker) pending = cloneDb(marker);
    },
    begin: (opIndex) => {
      pending = cloneDb(committed);
      savepoints.length = 0;
      beginOpIndex = opIndex;
    },
    commit: (opIndex) => {
      committed = cloneDb(pending);
      savepoints.length = 0;
      snapshots.push({
        opIndex,
        state: cloneDb(committed),
        beginOpIndex,
        walSyncCoveredOpIndex: opIndex,
      });
    },
    rollback: () => {
      pending = cloneDb(committed);
      savepoints.length = 0;
    },
    snapshots: () => snapshots,
    hasRow: (table, id) => tableOf(table).has(id),
  };
};

const EMPTY_STATE: DbState = new Map();

export const committedStateAt = (
  snapshots: readonly CommitSnapshot[],
  k: number,
): DbState => {
  let state: DbState = EMPTY_STATE;
  for (const s of snapshots) {
    if (s.opIndex <= k) state = s.state;
    else break;
  }
  return state;
};

const lastCommittedIndexAt = (snapshots: readonly CommitSnapshot[], k: number): number => {
  let idx = -1;
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    if (s !== undefined && s.opIndex <= k) idx = i;
    else break;
  }
  return idx;
};

const nextSnapshotAfter = (
  snapshots: readonly CommitSnapshot[],
  k: number,
): CommitSnapshot | undefined => {
  for (const s of snapshots) if (s.opIndex > k) return s;
  return undefined;
};

// Minimal durability-permitted band (newest-first): strict=FULL pins committedStateAt(k);
// NORMAL adds the unsynced-prefix rollback + in-flight next-commit roll-forward (durability-policy).
export const acceptableStatesAt = (
  snapshots: readonly CommitSnapshot[],
  k: number,
  strict: boolean,
): readonly DbState[] => {
  const out: DbState[] = [];
  const next = nextSnapshotAfter(snapshots, k);
  if (next !== undefined && next.beginOpIndex <= k) out.push(next.state);

  const lastIdx = lastCommittedIndexAt(snapshots, k);
  if (lastIdx < 0) {
    out.push(EMPTY_STATE);
    return out;
  }
  for (let i = lastIdx; i >= 0; i--) {
    const s = snapshots[i];
    if (s === undefined) continue;
    out.push(s.state);
    if (strict) return out;
    if (s.walSyncCoveredOpIndex <= k) return out;
  }
  out.push(EMPTY_STATE);
  return out;
};
