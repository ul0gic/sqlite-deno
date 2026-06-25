declare const brand: unique symbol;

/** A wasm i32 address branded by what it points at; the only boundary `as` reinterprets a `number` into one (see `glue.ts`). */
export type Ptr<Tag extends string> = number & { readonly [brand]: Tag };

export type VfsPtr = Ptr<"sqlite3_vfs">;
export type FilePtr = Ptr<"sqlite3_file">;
export type DbPtr = Ptr<"sqlite3">;
export type StmtPtr = Ptr<"sqlite3_stmt">;
export type BytePtr = Ptr<"byte">;
export type CStrPtr = Ptr<"cstr">;
export type OutPtr = Ptr<"out">;
