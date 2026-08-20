import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRODUCTION_NEON_ENDPOINT_ID,
  assertSafeDatabaseUrl,
} from "../src/config.js";

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
    /Refusing to run local development against production database/,
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
        { onRailway: false },
      ),
    );
  } finally {
    if (prev === undefined) delete process.env.ALLOW_PRODUCTION_DB;
    else process.env.ALLOW_PRODUCTION_DB = prev;
  }
});
