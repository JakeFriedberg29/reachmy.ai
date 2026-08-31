import { assertSafeDatabaseUrl } from "../src/config.js";

/**
 * CI/local preflight: refuse a production Neon DATABASE_URL without printing it.
 * GitHub Actions must supply the Neon development branch via secret DATABASE_URL_DEV.
 */
const databaseUrl = process.env.DATABASE_URL ?? "";
assertSafeDatabaseUrl(databaseUrl);
