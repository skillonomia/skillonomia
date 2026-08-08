// Minimal ambient declaration for the Bun-only module used by src/sqlite.ts.
// Typechecking runs under Node's tsc, which cannot resolve `bun:sqlite`; only
// the surface the adapter actually uses is declared here.
declare module "bun:sqlite" {
  export class Statement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): void;
  }
  export class Database {
    /** `readonly` opens with SQLITE_OPEN_READONLY — see src/db.ts openReadOnly. */
    constructor(path: string, options?: { readonly?: boolean });
    run(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
}
