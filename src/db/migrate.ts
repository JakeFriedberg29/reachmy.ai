import { migrate } from "drizzle-orm/postgres-js/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Database } from "./client.js";

export async function applyMigrations(db: Database, databaseUrl?: string): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, "..", "..", "drizzle");
  if (databaseUrl) {
    const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
    try {
      await migrate(drizzle(sql), { migrationsFolder });
    } finally {
      await sql.end({ timeout: 5 });
    }
    return;
  }
  await migrate(db, { migrationsFolder });
}
