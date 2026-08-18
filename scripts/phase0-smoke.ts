import { loadConfig } from "../src/config.js";
import { mintScriptToken } from "../src/auth/script-token.js";
import { createSql, createDb } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { loadOrCreateJwks } from "../src/db/jwks.js";
import { provisionTestPrincipal } from "../src/domain/identity.js";
import { createHttpServer } from "../src/server.js";

const suffix = Date.now().toString(36).slice(-6);

async function json(res: Response) {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.url}: ${text}`);
  }
  return body as Record<string, never> & {
    identity?: { account_id: string; principal_id: string; handle: string };
    token?: string;
    interaction?: { id: string; status: string };
    inbox?: { id: string; state: string; principalId: string }[];
    items?: { state: string; principalId: string; interactionId: string }[];
    proposal?: { id: string; status: string; type: string };
    approval?: { id: string; status: string };
    proposals?: { id: string; status: string; type: string }[];
    approvals?: { id: string; status: string; approverPrincipalId: string }[];
    events?: { type: string }[];
    audits?: { action: string }[];
    invite_id?: string;
    relationship_id?: string;
  };
}

async function main() {
  const config = loadConfig();
  const sql = createSql(config.databaseUrl);
  const db = createDb(sql);
  await applyMigrations(db, config.databaseUrl);
  const jwks = await loadOrCreateJwks(db);
  const server = await createHttpServer(config, db, jwks);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const jake = await provisionTestPrincipal(db, {
      clerkUserId: `phase0_jake_${suffix}`,
      email: `jake_${suffix}@example.test`,
      handle: `jake_${suffix}`.slice(0, 30),
      displayName: "Jake",
    });
    const daniel = await provisionTestPrincipal(db, {
      clerkUserId: `phase0_dan_${suffix}`,
      email: `dan_${suffix}@example.test`,
      handle: `dan_${suffix}`.slice(0, 30),
      displayName: "Daniel",
    });
    if (!jake.principal_id || !daniel.principal_id) throw new Error("principals missing");

    const jakeToken = mintScriptToken(jake.account_id, config.cookieKeys[0]!);
    const danielToken = mintScriptToken(daniel.account_id, config.cookieKeys[0]!);
    const headers = (token: string, body?: string) => ({
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    });
    const post = (token: string, url: string, body: unknown = {}) =>
      fetch(url, { method: "POST", headers: headers(token, "{}"), body: JSON.stringify(body) });
    const get = (token: string, url: string) => fetch(url, { headers: headers(token) });

    const health = await json(await fetch(`${base}/health`));
    if (!(health as { ok?: boolean }).ok) throw new Error("health failed");

    const invite = await json(await post(jakeToken, `${base}/v1/invites`));
    if (!invite.token) throw new Error("invite token missing");

    const accepted = await json(await post(danielToken, `${base}/v1/invites/${invite.token}/accept`));
    if (!accepted.relationship_id) throw new Error("relationship missing");

    const created = await json(
      await post(jakeToken, `${base}/v1/interactions`, {
        to: daniel.handle,
        intent: "Find 30 minutes to talk",
      }),
    );
    if (created.interaction?.status !== "PENDING") throw new Error("expected PENDING");

    const danInbox = await json(await get(danielToken, `${base}/v1/inbox`));
    const unread = danInbox.items?.find((item) => item.interactionId === created.interaction?.id);
    if (unread?.state !== "unread") throw new Error("recipient inbox not unread");

    const proposed = await json(
      await post(danielToken, `${base}/v1/interactions/${created.interaction!.id}/proposals`, {
        type: "TIME",
        payload: { start: "2026-08-20T15:00:00Z", end: "2026-08-20T15:30:00Z", timezone: "America/New_York" },
      }),
    );
    if (proposed.interaction?.status !== "AWAITING_OWNER") throw new Error("expected AWAITING_OWNER");
    if (proposed.proposal?.status !== "PROPOSED" || proposed.proposal.type !== "TIME") {
      throw new Error("expected TIME PROPOSED");
    }

    const jakeInbox = await json(await get(jakeToken, `${base}/v1/inbox`));
    const approvalItem = jakeInbox.items?.find((item) => item.interactionId === created.interaction?.id);
    if (approvalItem?.state !== "unread") throw new Error("approver inbox not unread");

    const approved = await json(await post(jakeToken, `${base}/v1/proposals/${proposed.proposal!.id}/approve`));
    if (approved.interaction?.status !== "AGREED") {
      throw new Error(`expected AGREED, got ${approved.interaction?.status}`);
    }

    const bundle = await json(await get(jakeToken, `${base}/v1/interactions/${created.interaction!.id}`));
    if (bundle.interaction?.status !== "AGREED") throw new Error("bundle status not AGREED");
    if (bundle.proposals?.[0]?.status !== "ACCEPTED") throw new Error("proposal not ACCEPTED");
    if (bundle.approvals?.[0]?.status !== "approved") throw new Error("approval not approved");
    if (!bundle.inbox?.every((item) => item.state === "archived")) throw new Error("inbox not archived");
    const eventTypes = new Set(bundle.events?.map((event) => event.type) ?? []);
    if (!eventTypes.has("INTERACTION_CREATED") || !eventTypes.has("PROPOSAL_CREATED") || !eventTypes.has("PROPOSAL_APPROVED")) {
      throw new Error(`missing events: ${[...eventTypes].join(",")}`);
    }
    if (!bundle.audits?.length) throw new Error("missing audit records");

    console.log(
      JSON.stringify({
        ok: true,
        phase: 0,
        interaction_status: bundle.interaction.status,
        proposal_status: bundle.proposals[0].status,
        approval_status: bundle.approvals[0].status,
        principals: [jake.principal_id, daniel.principal_id],
        handles: [jake.handle, daniel.handle],
      }),
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
