import assert from "node:assert/strict";
import { test } from "node:test";
import { hostnameFromUrl } from "../src/config.js";
import { httpRequest, sessionCookie, withServer } from "./helpers-http.js";
import { makePrincipal, testDb } from "./helpers.js";

function assertOnOriginLocation(location: string | string[] | undefined, publicUrl: string): void {
  const value = Array.isArray(location) ? location[0] : location;
  assert.ok(value, "expected Location header");
  assert.ok(!/^https?:\/\//i.test(value), `off-origin Location: ${value}`);
  assert.ok(!value.startsWith("//"), `protocol-relative Location: ${value}`);
  const origin = new URL(publicUrl).origin;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    assert.equal(new URL(value).origin, origin);
  }
}

test("MCP /sign-in rejects off-origin redirect for authenticated session", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const { identity } = await makePrincipal(db, "redirect_auth");
    const mcpHost = hostnameFromUrl(config.publicUrl);
    const res = await httpRequest(
      port,
      mcpHost,
      "/sign-in?redirect=https://evil.com",
      { headers: { cookie: sessionCookie(identity.account_id, config.cookieKeys[0]!) } },
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/security");
    assertOnOriginLocation(res.headers.location, config.publicUrl);
  });
});

test("MCP /sign-in sanitizes redirect embedded in sign-in page", async () => {
  await withServer(async (port, config) => {
    const mcpHost = hostnameFromUrl(config.publicUrl);
    const res = await httpRequest(port, mcpHost, "/sign-in?redirect=https://evil.com");
    assert.equal(res.status, 200);
    assert.match(res.body, /const redirectTo = "\/security"/);
    assert.doesNotMatch(res.body, /https:\/\/evil\.com/);
  });
});

test("Portal /sign-in rejects off-origin redirect for authenticated session", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const { identity } = await makePrincipal(db, "portal_redirect");
    const res = await httpRequest(
      port,
      config.portalHost,
      "/sign-in?redirect=https://evil.com",
      { headers: { cookie: sessionCookie(identity.account_id, config.cookieKeys[0]!) } },
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/");
    assertOnOriginLocation(res.headers.location, config.portalUrl);
  });
});
