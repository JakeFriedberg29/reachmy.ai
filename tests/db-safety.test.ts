import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEV_COOKIE_KEY_FALLBACK,
  EXAMPLE_COOKIE_KEY_PLACEHOLDER,
  MIN_COOKIE_KEY_LENGTH,
  PRODUCTION_NEON_ENDPOINT_ID,
  assertSafeCookieKeys,
  assertSafeDatabaseUrl,
  isProductionRuntime,
  isUnsafeCookieKey,
  parseCookieKeys,
} from "../src/config.js";

const VALID_PRODUCTION_KEY = "a".repeat(MIN_COOKIE_KEY_LENGTH);

test("assertSafeDatabaseUrl allows development Neon endpoint locally", () => {
  assert.doesNotThrow(() =>
    assertSafeDatabaseUrl(
      "postgresql://u:p@ep-steep-dream-ayihhbrl.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require",
      { onRailway: false },
    ),
  );
});

test("assertSafeDatabaseUrl refuses production Neon endpoint locally", () => {
  assert.throws(
    () =>
      assertSafeDatabaseUrl(
        `postgresql://u:p@${PRODUCTION_NEON_ENDPOINT_ID}.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require`,
        { onRailway: false },
      ),
    /Refusing to run local development or CI against production database/,
  );
});

test("assertSafeDatabaseUrl allows production endpoint on Railway", () => {
  assert.doesNotThrow(() =>
    assertSafeDatabaseUrl(
      `postgresql://u:p@${PRODUCTION_NEON_ENDPOINT_ID}-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require`,
      { onRailway: true },
    ),
  );
});

test("assertSafeDatabaseUrl allows production endpoint with explicit override", () => {
  const prev = process.env.ALLOW_PRODUCTION_DB;
  process.env.ALLOW_PRODUCTION_DB = "1";
  try {
    assert.doesNotThrow(() =>
      assertSafeDatabaseUrl(
        `postgresql://u:p@${PRODUCTION_NEON_ENDPOINT_ID}.c-5.us-east-2.aws.neon.tech/neondb`,
        { onRailway: false, inCi: false },
      ),
    );
  } finally {
    if (prev === undefined) delete process.env.ALLOW_PRODUCTION_DB;
    else process.env.ALLOW_PRODUCTION_DB = prev;
  }
});

test("assertSafeDatabaseUrl refuses production Neon in GitHub Actions", () => {
  assert.throws(
    () =>
      assertSafeDatabaseUrl(
        `postgresql://u:p@${PRODUCTION_NEON_ENDPOINT_ID}.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require`,
        { onRailway: false, inCi: true },
      ),
    /GitHub Actions must set secret DATABASE_URL_DEV/,
  );
});

test("assertSafeDatabaseUrl refuses production Neon in GitHub Actions even if Railway env leaked", () => {
  assert.throws(
    () =>
      assertSafeDatabaseUrl(
        `postgresql://u:p@${PRODUCTION_NEON_ENDPOINT_ID}-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require`,
        { onRailway: true, inCi: true },
      ),
    /GitHub Actions must set secret DATABASE_URL_DEV/,
  );
});

test("assertSafeDatabaseUrl ignores ALLOW_PRODUCTION_DB in GitHub Actions", () => {
  const prev = process.env.ALLOW_PRODUCTION_DB;
  process.env.ALLOW_PRODUCTION_DB = "1";
  try {
    assert.throws(
      () =>
        assertSafeDatabaseUrl(
          `postgresql://u:p@${PRODUCTION_NEON_ENDPOINT_ID}.c-5.us-east-2.aws.neon.tech/neondb`,
          { onRailway: false, inCi: true },
        ),
      /GitHub Actions must set secret DATABASE_URL_DEV/,
    );
  } finally {
    if (prev === undefined) delete process.env.ALLOW_PRODUCTION_DB;
    else process.env.ALLOW_PRODUCTION_DB = prev;
  }
});

test("isProductionRuntime treats Railway and public HTTPS hosts as production", () => {
  assert.equal(isProductionRuntime("http://localhost:3000", { onRailway: false }), false);
  assert.equal(isProductionRuntime("https://localhost:3000", { onRailway: false }), false);
  assert.equal(isProductionRuntime("https://mcp.reachmy.ai", { onRailway: false }), true);
  assert.equal(isProductionRuntime("http://localhost:3000", { onRailway: true }), true);
});

test("isUnsafeCookieKey rejects known defaults and short secrets", () => {
  assert.equal(isUnsafeCookieKey(""), true);
  assert.equal(isUnsafeCookieKey("short"), true);
  assert.equal(isUnsafeCookieKey(DEV_COOKIE_KEY_FALLBACK), true);
  assert.equal(isUnsafeCookieKey(EXAMPLE_COOKIE_KEY_PLACEHOLDER), true);
  assert.equal(isUnsafeCookieKey(VALID_PRODUCTION_KEY), false);
});

test("parseCookieKeys splits and trims comma-separated keys", () => {
  assert.deepEqual(parseCookieKeys(" one , two ", DEV_COOKIE_KEY_FALLBACK), ["one", "two"]);
  assert.deepEqual(parseCookieKeys(undefined, DEV_COOKIE_KEY_FALLBACK), [DEV_COOKIE_KEY_FALLBACK]);
});

test("assertSafeCookieKeys allows local development fallback with warning path", () => {
  assert.doesNotThrow(() =>
    assertSafeCookieKeys([DEV_COOKIE_KEY_FALLBACK], {
      production: false,
      envProvided: false,
    }),
  );
});

test("assertSafeCookieKeys refuses missing COOKIE_KEYS in production", () => {
  assert.throws(
    () =>
      assertSafeCookieKeys([DEV_COOKIE_KEY_FALLBACK], {
        production: true,
        envProvided: false,
      }),
    /COOKIE_KEYS is required in production/,
  );
});

test("assertSafeCookieKeys refuses development default in production", () => {
  assert.throws(
    () =>
      assertSafeCookieKeys([DEV_COOKIE_KEY_FALLBACK], {
        production: true,
        envProvided: true,
      }),
    /known development default/,
  );
});

test("assertSafeCookieKeys refuses example placeholder in production", () => {
  assert.throws(
    () =>
      assertSafeCookieKeys([EXAMPLE_COOKIE_KEY_PLACEHOLDER], {
        production: true,
        envProvided: true,
      }),
    /known development default/,
  );
});

test("assertSafeCookieKeys refuses short key in production", () => {
  assert.throws(
    () =>
      assertSafeCookieKeys(["too-short"], {
        production: true,
        envProvided: true,
      }),
    /too short/,
  );
});

test("assertSafeCookieKeys accepts strong production key", () => {
  assert.doesNotThrow(() =>
    assertSafeCookieKeys([VALID_PRODUCTION_KEY], {
      production: true,
      envProvided: true,
    }),
  );
});
