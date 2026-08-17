# Phase -1 validation (in progress)

Public URL: `https://reachmyai-production.up.railway.app`

## 2026-08-16 — first HTTPS smoke (failed, host/issuer)

Gate **B0 (process is up on Railway)** is true. Gate **B-1 (Claude OAuth read/write/refresh)** was blocked until the issuer and host allowlist matched the public hostname.

| Check | Result |
|---|---|
| Deploy status | Success (`9f582c8a`, Active) |
| `GET /health` | **403** `Invalid Host: reachmyai-production.up.railway.app` |
| `GET /` | **403** same |
| `GET /.well-known/oauth-protected-resource` | **403** same |
| `POST /mcp` (no token) | **403** same |
| `GET /.well-known/oauth-authorization-server` | 200, but `"issuer":"http://localhost:8080"` |
| `GET /jwks` | 200 |

Root cause: process booted without `PUBLIC_URL` / `RAILWAY_PUBLIC_DOMAIN`, so `publicUrl` was `http://localhost:8080`. MCP DNS-rebinding middleware only allowed `localhost`.

## 2026-08-17 — re-smoke after Railway variables (passed)

Operator set `PUBLIC_URL` and a unique `COOKIE_KEYS`. New deployment active.

| Check | Result |
|---|---|
| `GET /health` | **200** issuer/resource use the public hostname |
| `GET /` | **200** |
| `GET /.well-known/oauth-protected-resource` (and `/mcp`) | **200** |
| `GET /.well-known/oauth-authorization-server` | **200** issuer correct, PKCE S256, auth code + refresh |
| `POST /mcp` (no token) | **401** `invalid_token` + `WWW-Authenticate` → resource metadata |
| `GET /jwks` | **200** RS256 |

## 2026-08-17 — Claude consent stall: root cause and fix

**Symptom (operator):** the login page renders correctly, but clicking *Continue as Test Jake* lands on a new `/interaction/...` URL and never returns to Claude.

**Reproduced locally** against the deployed commit with a Claude-shaped client (dynamic registration, PKCE S256, `resource` indicator) using `scripts/oauth-smoke.mjs`. The redirect trail loops forever:

```
POST /interaction/A/login   → 303 /auth/A
GET  /auth/A                → 303 /interaction/B      (new interaction, not the client)
POST /interaction/B/login   → 303 /auth/B
GET  /auth/B                → 303 /interaction/C      …
```

**Root cause.** After login, oidc-provider re-prompts with:

```json
{ "prompt": "consent",
  "reasons": ["op_scopes_missing"],
  "details": { "missingOIDCScope": ["identity:read", "interactions:write"] } }
```

`finishLogin` granted only `addOIDCScope("openid offline_access")` plus a resource scope. The scopes the client actually requested (`identity:read`, `interactions:write`) were never granted **at the OIDC scope level**, so the consent prompt could never be satisfied. Each submission created a fresh interaction — an infinite consent loop. Nothing was wrong with cookies, sessions, PKCE, or the redirect URI.

**Fix.** Consent now grants exactly what the prompt reports missing (`missingOIDCScope`, `missingOIDCClaims`, `missingResourceScopes`) plus the requested scope and resource indicators, instead of a hardcoded list.

**Second defect found while testing.** A client that omits `scope` entirely (legal in OAuth 2.1) was rejected with `access_denied` — oidc-provider requires at least one requested scope before consent runs (`lib/actions/authorization/interactions.js`). The authorization endpoint now defaults a missing `scope` to the advertised set.

**Also fixed:** an uncommitted syntax error in `findAccount`, `claims` keyed on `sub` instead of `openid` (which leaked a bogus `sub` scope into discovery metadata), and an `authorization.success` listener that read a non-existent second argument.

### Verified end-to-end locally (post-fix)

Single consent, then straight back to the client:

```
GET  /auth?…            → 303 /interaction/A
GET  /interaction/A     → 200 (login page)
POST /interaction/A/login → 303 /auth/A
GET  /auth/A            → 303 https://claude.ai/api/mcp/auth_callback?code=…&state=…&iss=…
```

| Step | Result |
|---|---|
| Dynamic client registration | 201, `redirect_uri_allowed: true` |
| PKCE | `code_challenge_method: S256` survives consent; token exchange with verifier → 200 |
| Authorization code | issued, bound to grant + account + code challenge |
| Token exchange | 200, JWT access token, `aud` = `<public-url>/mcp`, `sub` = test account, `principal_id` claim present |
| MCP `get_identity` | 200, correct principal |
| MCP `create_test_item` | 200, item written |
| Refresh | 200, refresh token rotated; MCP call with refreshed token → 200 |
| Scope variants tested | full set, `openid`-prefixed, single scope, and no `scope` param — all pass |

Identity resolves from the stable internal account subject, not email.

### Operational note (Phase 0 input)

Client registrations, grants, sessions, and tokens live in an in-memory adapter. **Every redeploy or restart wipes Claude's registered client**, so the connector must be removed and re-added in Claude after each deploy. Phase 0 needs a real persistence layer for `oidc-provider` state.

## Still required from operator

1. Deploy the fix (Railway builds from GitHub `main`)
2. Remove any existing reachmy.ai connector in Claude, then re-add `https://reachmyai-production.up.railway.app/mcp`
3. Complete OAuth, confirm Claude shows the connector as connected
4. Call `get_identity` and `create_test_item`
5. Only then: wait 5+ minutes and re-call a tool to prove refresh in the real client

ChatGPT smoke remains optional. Agent-first UX observations still to be recorded after the Claude run.
