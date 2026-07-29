import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "../schema";

export type DB = PostgresJsDatabase<typeof schema>;

/**
 * Cache the postgres-js pool + Drizzle instance on `globalThis` so Next.js dev (Fast Refresh /
 * webpack HMR) reuses ONE pool across module re-evaluations. Without this, every recompile reset the
 * module-scoped singleton to `undefined` and the next query built a fresh `postgres({ max: 10 })`
 * pool whose connections — with no idle timeout — were never released, so a dev session leaked pools
 * until Postgres hit `max_connections` ("53300: sorry, too many clients already"). Production is
 * unaffected (no HMR); a single long-lived process gets exactly one pool either way.
 */
const globalForDb = globalThis as unknown as { __btmsPg?: Sql; __btmsDb?: DB };

function init(): DB {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. The BFF reaches Postgres via a direct, server-only connection (Drizzle).",
    );
  }
  const client = (globalForDb.__btmsPg ??= postgres(connectionString, {
    max: 10, // concurrency cap for the BFF's parallel reads (e.g. getTripFilterOptions' Promise.all)
    idle_timeout: 20, // seconds: release a pooled connection after 20s idle (frees bursts/strays)
    max_lifetime: 60 * 30, // seconds: recycle a connection after 30 min so none lingers forever
  }));
  return drizzle(client, { schema });
}

/** Returns the lazily-initialized singleton Drizzle client (server-only), cached across HMR. */
export function getDb(): DB {
  return (globalForDb.__btmsDb ??= init());
}

/**
 * Ergonomic accessor: `db.select()...`, `db.transaction(...)`, etc. The underlying Postgres
 * connection is initialized lazily on first use so importing this module never requires
 * DATABASE_URL at build time.
 */
export const db: DB = new Proxy({} as DB, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(real) : value;
  },
});

export { schema };
