import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair } from "jose";
import type { Database } from "./client.js";
import { asSigningKeys } from "./schema.js";

export type SigningJwks = { keys: Record<string, unknown>[] };

export async function loadOrCreateJwks(db: Database): Promise<SigningJwks> {
  const existing = await db.select().from(asSigningKeys).where(eq(asSigningKeys.id, "default")).limit(1);
  if (existing[0]?.jwks && typeof existing[0].jwks === "object") {
    return existing[0].jwks as SigningJwks;
  }

  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.use = "sig";
  jwk.alg = "RS256";
  jwk.kid = "phase0-as-1";
  const jwks = { keys: [jwk] };

  await db
    .insert(asSigningKeys)
    .values({ id: "default", jwks })
    .onConflictDoNothing({ target: asSigningKeys.id });

  const stored = await db.select().from(asSigningKeys).where(eq(asSigningKeys.id, "default")).limit(1);
  return (stored[0]?.jwks as SigningJwks) ?? jwks;
}
