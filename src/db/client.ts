import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>;

export function createSql(databaseUrl: string) {
  return postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 30,
    prepare: true,
  });
}

export function createDb(sql: ReturnType<typeof postgres>) {
  return drizzle(sql, { schema });
}

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
