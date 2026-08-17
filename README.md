# reachmy.ai

Phase -1 MCP + OAuth spike for Agent Network.

## Deploy / Railway

The **deployable Node app lives at the repository root**.

- `package.json` is in `/` (not a subdirectory)
- Railway **Root Directory must be empty / repository root**
- Builder: Railpack / Nixpacks Node detection via `package.json` + `pnpm-lock.yaml`
- Start command comes from `"start": "node dist/index.js"` after `"build": "tsc"`

Do not set Railway Root Directory to `apps/...`. There is no nested app.

Required Railway variables:

- `PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}` (or the hardcoded `https://reachmyai-production.up.railway.app`)
- `COOKIE_KEYS` — long random string for OAuth cookies

Without `PUBLIC_URL`, `/health` and `/mcp` 403 on the Railway hostname and the OAuth issuer is `http://localhost:8080`.

Endpoints after deploy:

- `GET /health`
- `POST /mcp` — Streamable HTTP MCP (`get_identity`, `create_test_item`)
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server` (oidc-provider)
- `/jwks`

Claude custom connector URL should be `https://<railway-host>/mcp`.

OAuth state (registered clients, grants, sessions, tokens) is in-memory, so **every redeploy
invalidates Claude's connector**. Remove and re-add the connector after each deploy.

## OAuth + MCP smoke test

Runs the full Claude-shaped flow (dynamic registration, PKCE, consent, token, MCP tools, refresh):

```bash
pnpm build && node dist/index.js          # terminal 1
node scripts/oauth-smoke.mjs http://localhost:8080   # terminal 2
```

`SCOPE="-"` omits the scope param; `REDIRECT_URI` overrides the client callback.

## Local

```bash
corepack enable
pnpm install
pnpm dev
```

Optional env: `PUBLIC_URL`, `COOKIE_KEYS`, `TEST_ACCOUNT_ID`, `TEST_PRINCIPAL_ID`.
