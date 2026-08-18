import type { IncomingMessage, ServerResponse } from "node:http";
import type Provider from "oidc-provider";
import { clerkFrontendApi } from "./auth/clerk.js";
import { completeOauthInteraction, logOauth } from "./auth/oidc.js";
import { decodeSessionCookie, readCookie, SESSION_COOKIE } from "./auth/session-cookie.js";
import type { AppConfig } from "./config.js";
import type { Database } from "./db/client.js";
import { getIdentityByAccountId } from "./domain/identity.js";
import { acceptInvite } from "./domain/invites.js";
import { requireActorPrincipal } from "./domain/identity.js";

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 3rem auto; max-width: 40rem; line-height: 1.45; }
      button, a.button { display: inline-block; background: #111; color: #fff; border: 0; padding: 0.7rem 1rem; border-radius: 6px; cursor: pointer; text-decoration: none; }
      code, pre { background: #f3f3f3; padding: 0.1rem 0.3rem; }
      pre { padding: 0.8rem; overflow-x: auto; font-size: 0.85rem; }
      .muted { color: #555; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

function accountIdFromRequest(req: IncomingMessage, cookieKey: string): string | null {
  return decodeSessionCookie(readCookie(req.headers.cookie, SESSION_COOKIE), cookieKey);
}

export function renderSignIn(config: AppConfig, redirectTo: string): string {
  const frontend = clerkFrontendApi(config.clerkPublishableKey);
  return htmlPage(
    "Sign in",
    `
    <h1>Sign in</h1>
    <p class="muted">Human account auth for Agent Network. After Clerk, you return to the original action.</p>
    <div id="clerk-app"></div>
    <script>
      const publishableKey = ${JSON.stringify(config.clerkPublishableKey)};
      const redirectTo = ${JSON.stringify(redirectTo)};
      const clerkJs = ${JSON.stringify(`https://${frontend}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`)};
      const script = document.createElement("script");
      script.src = clerkJs;
      script.setAttribute("data-clerk-publishable-key", publishableKey);
      script.onload = async () => {
        const Clerk = window.Clerk;
        await Clerk.load();
        if (!Clerk.user) {
          Clerk.mountSignIn(document.getElementById("clerk-app"));
          return;
        }
        const token = await Clerk.session.getToken();
        await fetch("/v1/auth/clerk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        window.location.href = redirectTo;
      };
      document.head.appendChild(script);
    </script>
  `,
  );
}

export function renderRecovery(): string {
  return htmlPage(
    "Recovery",
    `
    <h1>Account recovery</h1>
    <p>Use your Google or email recovery in Clerk. Agent Network does not use seed phrases.</p>
    <p><a class="button" href="/sign-in">Sign in</a></p>
  `,
  );
}

export function renderSecurity(connections: Array<{ id: string; displayLabel: string; status: string; grantId: string | null }>): string {
  const rows = connections
    .map(
      (c) =>
        `<li><code>${escapeHtml(c.displayLabel)}</code> — ${escapeHtml(c.status)}${c.grantId ? ` <span class="muted">grant ${escapeHtml(c.grantId.slice(0, 8))}</span>` : ""}</li>`,
    )
    .join("");
  return htmlPage(
    "Security",
    `
    <h1>Authorized agents</h1>
    <p class="muted">AI connections authorized to represent your Agent Name. Revoke a specific connection from your AI (it does not delete your Agent Name). Browser re-auth before revoke is the intended production UX.</p>
    <ul>${rows || "<li>No connections</li>"}</ul>
    <p><a class="button" href="/sign-in">Sign in</a></p>
  `,
  );
}

export function renderInvite(token: string): string {
  return htmlPage(
    "Accept invite",
    `
    <h1>Accept invite</h1>
    <p>Sign in first, then accept. This is the fallback if an AI client cannot complete the flow.</p>
    <form method="post" action="/invite/${encodeURIComponent(token)}">
      <button type="submit">Accept invite</button>
    </form>
  `,
  );
}

export async function handleInvitePost(
  db: Database,
  config: AppConfig,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  const accountId = accountIdFromRequest(req, config.cookieKeys[0]!);
  if (!accountId) {
    res.statusCode = 302;
    res.setHeader("location", `/sign-in?redirect=${encodeURIComponent(`/invite/${token}`)}`);
    res.end();
    return;
  }
  try {
    const actor = await requireActorPrincipal(db, accountId);
    const result = await acceptInvite(db, actor, token);
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      htmlPage(
        "Invite accepted",
        `<h1>Connected</h1><p>Relationship <code>${result.relationship.id}</code> is active.</p>`,
      ),
    );
  } catch (error) {
    res.statusCode = 400;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(htmlPage("Invite error", `<h1>Could not accept invite</h1><p>${escapeHtml(String(error))}</p>`));
  }
}

export async function handleInteraction(
  provider: Provider,
  config: AppConfig,
  db: Database,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", config.publicUrl);
  const match = url.pathname.match(/^\/interaction\/([^/]+)(\/login)?$/);
  if (!match) return false;

  const accountId = accountIdFromRequest(req, config.cookieKeys[0]!);

  if (req.method === "GET" && !match[2]) {
    if (!accountId) {
      res.statusCode = 302;
      res.setHeader("location", `/sign-in?redirect=${encodeURIComponent(url.pathname)}`);
      res.end();
      return true;
    }
    const details = await provider.interactionDetails(req, res);
    logOauth("interaction_get", {
      uid: details.uid,
      prompt: details.prompt.name,
      reasons: details.prompt.reasons,
      redirect_uri: details.params.redirect_uri ?? null,
      client_id: details.params.client_id ?? null,
    });

    if (details.prompt.name !== "login") {
      await completeOauthInteraction(provider, config, req, res, accountId);
      return true;
    }

    const identity = await getIdentityByAccountId(db, accountId);
    const redirectUri = String(details.params.redirect_uri ?? "");
    const label = identity.handle ? `@${identity.handle}` : identity.account_id;
    const body = htmlPage(
      "Authorize agent",
      `
      <h1>Authorize an agent</h1>
      <p>This grant maps to your Agent Network account subject <code>${escapeHtml(identity.account_id)}</code>. Email is never used as the OAuth subject.</p>
      <p>Continue as <code>${escapeHtml(label)}</code>.</p>
      <form method="post" action="/interaction/${details.uid}/login">
        <button type="submit">Allow</button>
      </form>
      <pre>${escapeHtml(
        JSON.stringify(
          {
            prompt: details.prompt.name,
            client_id: details.params.client_id,
            redirect_uri: redirectUri,
            scope: details.params.scope,
            resource: details.params.resource,
            code_challenge_method: details.params.code_challenge_method,
          },
          null,
          2,
        ),
      )}</pre>
    `,
    );
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(body);
    return true;
  }

  if (req.method === "POST" && match[2] === "/login") {
    if (!accountId) {
      res.statusCode = 302;
      res.setHeader("location", `/sign-in?redirect=${encodeURIComponent(`/interaction/${match[1]}`)}`);
      res.end();
      return true;
    }
    logOauth("interaction_post_login", { uid: match[1], path: req.url });
    await completeOauthInteraction(provider, config, req, res, accountId);
    return true;
  }

  return false;
}

export function renderDevCallback(config: AppConfig, query: URLSearchParams): string {
  return htmlPage(
    "OAuth callback",
    `
    <h1>OAuth callback</h1>
    <p>Use this page only for local CLI debugging. Copy the <code>code</code> below into the token request.</p>
    <pre>${escapeHtml(query.toString())}</pre>
    <p><a class="button" href="${config.publicUrl}/health">Health</a></p>
  `,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
