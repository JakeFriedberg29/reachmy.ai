import { eq } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import { accounts } from "../db/schema.js";
import { forbidden, notFound } from "./errors.js";

export type PlatformRole = "user" | "admin";

export async function getAccountPlatformRole(
  db: Database | Tx,
  accountId: string,
): Promise<PlatformRole> {
  const [account] = await db
    .select({ platformRole: accounts.platformRole })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) throw notFound("Account not found");
  return account.platformRole as PlatformRole;
}

export async function requirePlatformAdmin(db: Database | Tx, accountId: string): Promise<void> {
  const role = await getAccountPlatformRole(db, accountId);
  if (role !== "admin") {
    throw forbidden("Platform admin access required");
  }
}
