# reachmy.ai

Phase 1 Agent Network: MCP tools over the Phase 0 domain core.

**Agent Name** is the durable identity (example: `@jake`). Claude and ChatGPT are AI connections that may represent that Agent Name — they are not the identity.

Canonical implementation plan: [`docs/implementation-plan.md`](docs/implementation-plan.md).

Hosts: `reachmy.ai` (marketing), `app.reachmy.ai` (ReachMy Portal — Phase 3), `mcp.reachmy.ai` (MCP/OAuth/backend). Shared MCP URL: `https://mcp.reachmy.ai/mcp`.

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
- `DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`

Without `PUBLIC_URL`, `/health` and `/mcp` 403 on the Railway hostname and the OAuth issuer is `http://localhost:8080`.

Endpoints after deploy:

- `GET /health`
- `POST /mcp` — Streamable HTTP MCP (identity, invites, interactions, TIME proposals, revoke)
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server` (oidc-provider)
- `/jwks`

Claude and ChatGPT connector URL: `https://mcp.reachmy.ai/mcp`.

OAuth clients, grants, sessions, and tokens persist in Postgres.

## OAuth + MCP smoke test

```bash
pnpm smoke:phase1
```

`scripts/oauth-smoke.mjs` still exercises DCR + PKCE + refresh against a running server.

## Local

```bash
corepack enable
pnpm install
pnpm dev
```

Required env: `PUBLIC_URL`, `COOKIE_KEYS`, `DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`.
