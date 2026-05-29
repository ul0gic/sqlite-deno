declare const brand: unique symbol;

/**
 * A wasm linear-memory address, branded by what it points at. The ABI sees a
 * bare i32; the compiler enforces that an `sqlite3_file*` is never confused with
 * an `sqlite3_vfs*` or a raw byte offset. Reinterpreting an upstream `number`
 * into one of these is the single allowed boundary `as` (see `glue.ts`).
 */
export type Ptr<Tag extends string> = number & { readonly [brand]: Tag };

export type VfsPtr = Ptr<"sqlite3_vfs">;
export type FilePtr = Ptr<"sqlite3_file">;
export type BytePtr = Ptr<"byte">;
export type CStrPtr = Ptr<"cstr">;
export type OutPtr = Ptr<"out">;
