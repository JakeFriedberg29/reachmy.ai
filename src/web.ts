import type { IncomingMessage, ServerResponse } from "node:http";
import type Provider from "oidc-provider";
import type { AppConfig } from "./config.js";
import { completeOauthInteraction, logOauth } from "./auth/oidc.js";

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
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

export async function handleInteraction(
  provider: Provider,
  config: AppConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", config.publicUrl);
  const match = url.pathname.match(/^\/interaction\/([^/]+)(\/login)?$/);
  if (!match) return false;

  if (req.method === "GET" && !match[2]) {
    const details = await provider.interactionDetails(req, res);
    logOauth("interaction_get", {
      uid: details.uid,
      prompt: details.prompt.name,
      reasons: details.prompt.reasons,
      redirect_uri: details.params.redirect_uri ?? null,
      client_id: details.params.client_id ?? null,
    });

    if (details.prompt.name !== "login") {
      await completeOauthInteraction(provider, config, req, res);
      return true;
    }

    const redirectUri = String(details.params.redirect_uri ?? "");
    const body = htmlPage(
      "reachmy.ai login",
      `
      <h1>reachmy.ai Phase -1</h1>
      <p>This spike maps OAuth to a single test principal. Provider name is never used for authorization.</p>
      <p>Sign in as <code>@${config.testHandle}</code> (account <code>${config.testAccountId}</code>).</p>
      <form method="post" action="/interaction/${details.uid}/login">
        <button type="submit">Continue as ${config.testDisplayName}</button>
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
    logOauth("interaction_post_login", { uid: match[1], path: req.url });
    await completeOauthInteraction(provider, config, req, res);
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
