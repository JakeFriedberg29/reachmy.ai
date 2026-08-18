import { Hono } from "hono";
import { sessionCookieHeader } from "../auth/session-cookie.js";
import { clerkFrontendApi, verifyClerkJwt } from "../auth/clerk.js";
import { createIdentity, getIdentityByAccountId, listConnections, upsertAccountByClerkUser } from "../domain/identity.js";
import { acceptInvite, createInvite } from "../domain/invites.js";
import {
  approveProposal,
  createCoordinateInteraction,
  createTimeProposal,
  getInteractionBundle,
  listInbox,
  rejectProposal,
  respondToInteraction,
} from "../domain/interactions.js";
import { type AppEnv, errorJson, optionalIdentity, requireAccount, requireActor } from "./context.js";

export function createV1Routes() {
  const app = new Hono<AppEnv>();

  app.post("/v1/auth/clerk", async (c) => {
    const config = c.get("config");
    const db = c.get("db");
    const body = await c.req.json().catch(() => ({}));
    const token =
      (typeof body.token === "string" ? body.token : null) ??
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
      null;
    if (!token) return c.json({ error: "unauthorized", message: "Clerk token required" }, 401);
    try {
      const payload = await verifyClerkJwt(config, token);
      if (!payload.sub) return c.json({ error: "unauthorized", message: "Clerk subject missing" }, 401);
      const identity = await upsertAccountByClerkUser(db, {
        clerkUserId: payload.sub,
        email: typeof payload.email === "string" ? payload.email : null,
      });
      c.header(
        "set-cookie",
        sessionCookieHeader(identity.account_id, config.cookieKeys[0]!, config.publicUrl.startsWith("https")),
      );
      return c.json({ identity, clerk_frontend_api: clerkFrontendApi(config.clerkPublishableKey) });
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.get("/v1/me", requireAccount, async (c) => {
    try {
      const identity = await optionalIdentity(c);
      return c.json({ identity });
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.post("/v1/identities", requireAccount, async (c) => {
    const db = c.get("db");
    const accountId = c.get("accountId")!;
    const body = await c.req.json().catch(() => ({}));
    try {
      const identity = await createIdentity(db, accountId, {
        handle: String(body.handle ?? ""),
        displayName: String(body.display_name ?? body.displayName ?? ""),
      });
      return c.json({ identity }, 201);
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.post("/v1/invites", requireActor, async (c) => {
    try {
      const { invite, token } = await createInvite(c.get("db"), c.get("actor")!);
      return c.json(
        {
          invite_id: invite.id,
          token,
          expires_at: invite.expiresAt.toISOString(),
          accept_url: `${c.get("config").publicUrl}/invite/${token}`,
        },
        201,
      );
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.post("/v1/invites/:token/accept", requireActor, async (c) => {
    try {
      const result = await acceptInvite(c.get("db"), c.get("actor")!, String(c.req.param("token")));
      return c.json({
        relationship_id: result.relationship.id,
        invite_id: result.invite.id,
      });
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.get("/v1/inbox", requireActor, async (c) => {
    try {
      const items = await listInbox(c.get("db"), c.get("actor")!);
      return c.json({ items });
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.post("/v1/interactions", requireActor, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await createCoordinateInteraction(c.get("db"), c.get("actor")!, {
        toHandle: String(body.to ?? body.to_handle ?? ""),
        intent: String(body.intent ?? ""),
        constraints: body.constraints ?? null,
      });
      return c.json(result, 201);
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.get("/v1/interactions/:id", requireActor, async (c) => {
    try {
      const bundle = await getInteractionBundle(c.get("db"), c.get("actor")!, String(c.req.param("id")));
      return c.json(bundle);
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.post("/v1/interactions/:id/respond", requireActor, async (c) => {
    try {
      return c.json(await respondToInteraction(c.get("db"), c.get("actor")!, String(c.req.param("id"))));
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.post("/v1/interactions/:id/proposals", requireActor, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const type = String(body.type ?? "TIME").toUpperCase();
    if (type !== "TIME") return c.json({ error: "unsupported_type", message: "Phase 0 supports TIME only" }, 400);
    try {
      return c.json(
        await createTimeProposal(c.get("db"), c.get("actor")!, String(c.req.param("id")), {
          ...(typeof body.payload === "object" && body.payload ? body.payload : body),
        }),
        201,
      );
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.post("/v1/proposals/:id/approve", requireActor, async (c) => {
    try {
      return c.json(await approveProposal(c.get("db"), c.get("actor")!, String(c.req.param("id"))));
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.post("/v1/proposals/:id/reject", requireActor, async (c) => {
    try {
      return c.json(await rejectProposal(c.get("db"), c.get("actor")!, String(c.req.param("id"))));
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.get("/v1/connections", requireActor, async (c) => {
    try {
      return c.json({ connections: await listConnections(c.get("db"), c.get("actor")!.principalId) });
    } catch (error) {
      return errorJson(c, error);
    }
  });

  app.get("/v1/identities/me", requireAccount, async (c) => {
    try {
      return c.json({ identity: await getIdentityByAccountId(c.get("db"), c.get("accountId")!) });
    } catch (error) {
      return errorJson(c, error);
    }
  });

  return app;
}
