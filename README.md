# reachmy.ai

Phase -1 MCP + OAuth spike for Agent Network.

## Deploy / Railway

The **deployable Node app lives at the repository root**.

- `package.json` is in `/` (not a subdirectory)
- Railway **Root Directory must be empty / repository root**
- Builder: Railpack / Nixpacks Node detection via `package.json` + `pnpm-lock.yaml`
- Start command comes from `"start": "node dist/index.js"` after `"build": "tsc"`

Do not set Railway Root Directory to `apps/...`. There is no nested app.

Endpoints after deploy:

- `GET /health`
- `POST /mcp` — Streamable HTTP MCP (`get_identity`, `create_test_item`)
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server` (oidc-provider)
- `/jwks`

Claude custom connector URL should be `https://<railway-host>/mcp`.

## Local

```bash
corepack enable
pnpm install
pnpm dev
```

Optional env: `PUBLIC_URL`, `COOKIE_KEYS`, `TEST_ACCOUNT_ID`, `TEST_PRINCIPAL_ID`.
