import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { mintScriptToken } from "../src/auth/script-token.js";
import { accounts } from "../src/db/schema.js";
import {
  createIdentity,
  ensureProvisionalPrincipal,
  upsertAccountByClerkUser,
} from "../src/domain/identity.js";
import { isPortalHostAllowedPath } from "../src/http/host.js";
import {
  portalButton,
  portalCard,
  portalConnectionRow,
  portalLayout,
  portalModal,
  portalStatusBadge,
  portalStyles,
} from "../src/http/portal-ui.js";
import { httpRequest, seedAiConnection, sessionCookie, withServer } from "./helpers-http.js";
import { obtainOAuthAccessToken } from "./helpers-oauth-token.js";
import { makeGrantPrincipal, suffix, testDb } from "./helpers.js";

function assertNoSensitiveLeak(html: string) {
  assert.doesNotMatch(html, /grant_id|oauth_client_id|agent_connection_id|principal_id|clerk_user_id/i);
  assert.doesNotMatch(html, /client_secret|access_token|refresh_token/i);
  assert.doesNotMatch(html, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
}

test("Slice 5 style system exports reusable Portal helpers", () => {
  assert.match(portalStyles(), /--rm-ink/);
  assert.match(portalStyles(), /\.rm-card/);
  assert.match(portalStyles(), /\.rm-btn--danger/);
  assert.match(portalStyles(), /\.rm-modal/);
  assert.match(portalCard({ title: "Demo", body: "<p>Hi</p>" }), /rm-card/);
  assert.match(portalButton({ label: "Go", variant: "primary" }), /rm-btn--primary/);
  assert.match(portalStatusBadge("connected"), /Connected/);
  assert.match(
    portalConnectionRow({ label: "Claude", status: "connected", actionHtml: "x" }),
    /rm-connection-row/,
  );
  assert.match(
    portalModal({
      id: "disconnect-claude",
      title: "Disconnect Claude?",
      bodyHtml: "<p>Confirm</p>",
      actionsHtml: portalButton({ label: "Cancel", variant: "secondary" }),
    }),
    /rm-modal/,
  );
  assert.match(portalLayout({ title: "T", body: "<p>x</p>", active: "home" }), /ReachMy/);
});

test("Slice 5: unauthenticated Portal / redirects to /sign-in", async () => {
  await withServer(async (port, config) => {
    const res = await httpRequest(port, config.portalHost, "/");
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/sign-in");
  });
});

test("Slice 5: authenticated Portal / returns 200 HTML home", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, {
      clerkUserId: `portal_home_${tag}`,
      email: `home_${tag}@example.test`,
    });
    const res = await httpRequest(port, config.portalHost, "/", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(res.body, /ReachMy/);
    assert.match(res.body, /Your AI Connections/);
    assert.match(res.body, /Agent Name/);
  });
});

test("Slice 5: claimed Agent Name displays correctly", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const handle = `claim_${tag}`.slice(0, 30);
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `claimed_ui_${tag}` });
    await createIdentity(db, account.account_id, { handle, displayName: "Claimed" });
    const res = await httpRequest(port, config.portalHost, "/", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, new RegExp(`@${handle}`));
    assert.doesNotMatch(res.body, /Not claimed yet/);
  });
});

test("Slice 5: provisional user displays Not claimed yet", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `prov_ui_${tag}` });
    await ensureProvisionalPrincipal(db, account.account_id);
    const res = await httpRequest(port, config.portalHost, "/", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /Not claimed yet/);
  });
});

test("Slice 5: Claude and ChatGPT connection states render correctly", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const handle = `conn_${tag}`.slice(0, 30);
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `conn_ui_${tag}` });
    const identity = await createIdentity(db, account.account_id, { handle, displayName: "Conn" });
    await seedAiConnection(db, identity.principal_id!, {
      clientPayload: { client_name: "Claude" },
      grantId: `grant_claude_ui_${tag}`,
    });
    const res = await httpRequest(port, config.portalHost, "/", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /Claude/);
    assert.match(res.body, /ChatGPT/);
    assert.match(res.body, /Connected/);
    assert.match(res.body, /Not connected/);
    assert.match(res.body, /Connect ChatGPT/);
    assertNoSensitiveLeak(res.body);
  });
});

test("Slice 5: disconnected providers display Not connected", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `disc_ui_${tag}` });
    const res = await httpRequest(port, config.portalHost, "/", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.equal((res.body.match(/Not connected/g) ?? []).length >= 2, true);
  });
});

test("Slice 5: /account requires human Portal authentication", async () => {
  await withServer(async (port, config) => {
    const res = await httpRequest(port, config.portalHost, "/account");
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/sign-in?redirect=%2Faccount");
  });
});

test("Slice 5: /account shows only authenticated user's data", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const handleA = `acca_${tag}`.slice(0, 30);
    const handleB = `accb_${tag}`.slice(0, 30);
    const accountA = await upsertAccountByClerkUser(db, {
      clerkUserId: `acc_a_${tag}`,
      email: `a_${tag}@example.test`,
    });
    const accountB = await upsertAccountByClerkUser(db, {
      clerkUserId: `acc_b_${tag}`,
      email: `b_${tag}@example.test`,
    });
    await createIdentity(db, accountA.account_id, { handle: handleA, displayName: "A" });
    await createIdentity(db, accountB.account_id, { handle: handleB, displayName: "B" });

    const res = await httpRequest(port, config.portalHost, "/account", {
      cookie: sessionCookie(accountA.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, new RegExp(`a_${tag}@example\\.test`));
    assert.match(res.body, new RegExp(`@${handleA}`));
    assert.doesNotMatch(res.body, new RegExp(`b_${tag}@example\\.test`));
    assert.doesNotMatch(res.body, new RegExp(`@${handleB}`));
    assertNoSensitiveLeak(res.body);
  });
});

test("Slice 5: sign-out clears Portal an_session", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `signout_${tag}` });
    const cookie = sessionCookie(account.account_id, config.cookieKeys[0]!);
    const res = await httpRequest(port, config.portalHost, "/sign-out", {
      method: "POST",
      cookie,
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join("\n") : String(setCookie ?? "");
    assert.match(cookieHeader, /an_session=/);
    assert.match(cookieHeader, /Max-Age=0/i);
    assert.match(res.body, /Signing out|\/sign-in/i);
  });
});

test("Slice 5: MCP OAuth and script tokens cannot authenticate Portal pages", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const { identity } = await makeGrantPrincipal(db, "oauth_portal_ui", "Claude");
    await db.update(accounts).set({ platformRole: "admin" }).where(eq(accounts.id, identity.account_id));
    const oauthToken = await obtainOAuthAccessToken(port, config, identity.account_id);
    const script = mintScriptToken(identity.account_id, config.cookieKeys[0]!);

    const oauthHome = await httpRequest(port, config.portalHost, "/", {
      authorization: `Bearer ${oauthToken}`,
    });
    assert.equal(oauthHome.status, 302);
    assert.equal(oauthHome.headers.location, "/sign-in");

    const scriptHome = await httpRequest(port, config.portalHost, "/", {
      authorization: `Bearer ${script}`,
    });
    assert.equal(scriptHome.status, 302);
    assert.equal(scriptHome.headers.location, "/sign-in");

    const oauthAccount = await httpRequest(port, config.portalHost, "/account", {
      authorization: `Bearer ${oauthToken}`,
    });
    assert.equal(oauthAccount.status, 302);
  });
});

test("Slice 5: /admin behavior from Slice 1 remains unchanged", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const user = await upsertAccountByClerkUser(db, { clerkUserId: `admin_user_${tag}` });
    const admin = await upsertAccountByClerkUser(db, { clerkUserId: `admin_ok_${tag}` });
    await db.update(accounts).set({ platformRole: "admin" }).where(eq(accounts.id, admin.account_id));

    const denied = await httpRequest(port, config.portalHost, "/admin", {
      cookie: sessionCookie(user.account_id, config.cookieKeys[0]!),
    });
    assert.equal(denied.status, 403);

    const allowed = await httpRequest(port, config.portalHost, "/admin", {
      cookie: sessionCookie(admin.account_id, config.cookieKeys[0]!),
    });
    assert.equal(allowed.status, 200);
    assert.match(allowed.body, /ReachMy Admin/);
  });
});

test("Slice 5: Portal pages unavailable on MCP host where required", async () => {
  await withServer(async (port, config) => {
    const mcpHost = new URL(config.publicUrl).hostname;
    const account = await httpRequest(port, mcpHost, "/account");
    assert.notEqual(account.status, 200);
    const overview = await httpRequest(port, mcpHost, "/v1/portal/overview");
    assert.notEqual(overview.status, 200);
  });
});

test("Slice 5: MCP/OAuth routes remain unavailable on Portal host", async () => {
  await withServer(async (port, config) => {
    assert.equal((await httpRequest(port, config.portalHost, "/mcp", { method: "POST" })).status, 404);
    assert.equal((await httpRequest(port, config.portalHost, "/auth")).status, 404);
    assert.equal((await httpRequest(port, config.portalHost, "/v1/me")).status, 404);
    assert.equal(isPortalHostAllowedPath("GET", "/connect/claude"), true);
    assert.equal(isPortalHostAllowedPath("GET", "/connect/chatgpt"), true);
    assert.equal(isPortalHostAllowedPath("POST", "/v1/auth/clerk"), true);
  });
});

test("Slice 5: /sign-in is public HTML", async () => {
  await withServer(async (port, config) => {
    const res = await httpRequest(port, config.portalHost, "/sign-in");
    assert.equal(res.status, 200);
    assert.match(res.body, /Sign in/);
    assert.match(res.body, /clerk/i);
  });
});
