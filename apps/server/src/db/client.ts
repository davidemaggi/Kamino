import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

/** Lazy: no connection is opened until the first query. */
export function createDb(url: string): Db {
  // connect_timeout (seconds) bounds a stalled connect; readiness also races its own timer.
  const client = postgres(url, { max: 10, connect_timeout: 2, onnotice: () => undefined });
  return drizzle(client, { schema });
}
