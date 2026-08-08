// Runtime-portable SQLite adapter: bun:sqlite under Bun, node:sqlite under Node.
// One shared minimal interface so business code and tests never fork on runtime.
export interface Stmt {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number };
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

/**
 * How a connection is opened. `readonly` is not a hint: SQLite opens the file
 * with `SQLITE_OPEN_READONLY`, so any write — including the `PRAGMA
 * journal_mode=WAL` a normal open issues, which rewrites the database header —
 * fails at the engine rather than being trusted not to happen. That is what an
 * audit of a snapshot, or of a database whose file is mode 0444, needs.
 */
export interface OpenOptions {
  readonly?: boolean;
}

const isBun = typeof (globalThis as any).Bun !== "undefined";

let openImpl: (path: string, opts: OpenOptions) => Db;

if (isBun) {
  const { Database } = await import("bun:sqlite");
  openImpl = (path: string, opts: OpenOptions) => {
    // Only pass options when a read-only handle is asked for: bun:sqlite reads
    // an options object as the COMPLETE flag set, so `{readonly:false}` means
    // "neither readwrite nor create" and fails with SQLITE_MISUSE.
    const db = opts.readonly === true ? new Database(path, { readonly: true }) : new Database(path);
    return {
      exec: (sql: string) => {
        db.run(sql);
      },
      prepare: (sql: string): Stmt => {
        const st = db.prepare(sql);
        return {
          get: (...p: unknown[]) => st.get(...(p as any[])) ?? undefined,
          all: (...p: unknown[]) => st.all(...(p as any[])),
          run: (...p: unknown[]) => {
            st.run(...(p as any[]));
            const c = db.prepare("SELECT changes() AS c").get() as { c: number };
            return { changes: c.c };
          },
        };
      },
      close: () => db.close(),
    };
  };
} else {
  const { DatabaseSync } = await import("node:sqlite");
  openImpl = (path: string, opts: OpenOptions) => {
    // node:sqlite rejects an explicit `undefined` options argument, so the two
    // forms are separate calls here as well
    const db = opts.readonly === true ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string): Stmt => {
        const st = db.prepare(sql);
        return {
          get: (...p: unknown[]) => st.get(...(p as any[])),
          all: (...p: unknown[]) => st.all(...(p as any[])),
          run: (...p: unknown[]) => {
            const r = st.run(...(p as any[]));
            return { changes: Number(r.changes) };
          },
        };
      },
      close: () => db.close(),
    };
  };
}

export function openSqlite(path: string, opts: OpenOptions = {}): Db {
  return openImpl(path, opts);
}
