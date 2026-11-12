// DB client. Lazy: nothing opens at import time (safe for `next build`).
// Usage: `const db = await getDb();` then the normal Drizzle query builder / `db.query.*`.
// PGlite (DATABASE_URL empty) is single-process: don't open ./.data/pglite from two
// processes at once (e.g. a script while `npm run dev` is running).
import fs from "node:fs";
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { env } from "@/src/lib/env";
import * as schema from "./schema";

export * from "./schema";
export { schema };

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

type DbState = { promise: Promise<Db> | null; close: (() => Promise<void>) | null };
const g = globalThis as unknown as { __aaDb?: DbState };
const state: DbState = (g.__aaDb ??= { promise: null, close: null });

const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");
export const PGLITE_DIR = path.join(process.cwd(), ".data", "pglite");

async function init(): Promise<Db> {
  if (env.DATABASE_URL) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const client = postgres(env.DATABASE_URL, { max: 10, onnotice: () => {} });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    state.close = () => client.end();
    return db as unknown as Db;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  fs.mkdirSync(PGLITE_DIR, { recursive: true });
  const client = new PGlite(PGLITE_DIR);
  await client.waitReady;
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  state.close = () => client.close();
  return db as unknown as Db;
}

/** Lazy singleton (survives Next HMR via globalThis). Runs migrations once on first use. */
export function getDb(): Promise<Db> {
  if (!state.promise) {
    state.promise = init().catch((err) => {
      state.promise = null; // allow retry on next call
      throw err;
    });
  }
  return state.promise;
}

/** Close the connection (for scripts so the process can exit). */
export async function closeDb(): Promise<void> {
  if (!state.promise) return;
  await state.promise.catch(() => {});
  await state.close?.();
  state.promise = null;
  state.close = null;
}
