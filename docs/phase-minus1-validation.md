# Phase -1 validation — PASSED

**Date:** 2026-08-17  
**Public URL:** `https://reachmyai-production.up.railway.app`  
**MCP resource:** `https://reachmyai-production.up.railway.app/mcp`  
**Deployed fix:** `80c16d8`  
**Gate B-1:** PASSED — Claude MCP + OAuth + write + refresh + this report. Phase 0 product work is unblocked.

| Exit criterion | Result |
|---|---|
| Public HTTPS MCP works | Pass |
| Claude connects | Pass (operator, real Claude connector) |
| OAuth completes | Pass — browser returns to Claude; connector shows connected |
| Maps to correct principal via **stable internal subject** (not email) | Pass — JWT `sub` = test `account_id` UUID; `principal_id` extra claim |
| Read tool `get_identity` | Pass (Claude + production smoke) |
| Write tool `create_test_item` | Pass (Claude + production smoke) |
| Refresh survives access-token expiry | Pass — production `scripts/oauth-smoke.mjs`: `grant_type=refresh_token` 200, token rotated, MCP call with new access token 200. Access TTL is 300s. |
| This report | This file |
| ChatGPT smoke | Not attempted (optional; does not block Phase 0) |

---

## Technical findings

**Client / plan:** Claude Pro/Max custom connector. Streamable HTTP MCP at `POST /mcp`. Discovery:

- `/.well-known/oauth-protected-resource` (+ `/mcp`)
- `/.well-known/oauth-authorization-server`
- `/jwks` RS256

**PKCE:** S256 required and used. Challenge survives consent. Token exchange with verifier succeeds.

**Refresh:** `offline_access` / refresh tokens issued; rotation enabled. Production smoke after consent: access token 300s, refresh grant 200, rotated refresh token, subsequent MCP `get_identity` 200.

**Stable claims (for Phase 0 `agent_connections`):**

| Claim | Observed | Use |
|---|---|---|
| `sub` | Agent Network **account UUID** (`TEST_ACCOUNT_ID`) | Principal mapping. Never email. |
| `principal_id` | Extra token claim (`TEST_PRINCIPAL_ID`) | Convenience; canonical path is `sub` → account → principal |
| `aud` | `https://…/mcp` | Resource indicator |
| `client_id` | New id per **dynamic client registration** (per connector install) | Distinguishes installs; not a stable human id |
| `jti` | Access-token id | Per-token, not grant identity |
| Provider name | Not present; never used for authorization | Label-only if ever added |

**Grant / install distinguishability:** Claude registers via DCR (`features.registration`). Each add-connector produces a new `client_id`. That is the closest stable “installation” key in this spike. oidc-provider grant ids exist server-side but are in-memory and wiped on restart. Phase 0 should persist AS state and unique `agent_connections` on `(principal_id, grant_id)` or `(principal_id, oauth_client_id)` once a durable grant id is stored — **not** `(principal_id, provider)`.

**Transport:** Streamable HTTP first; no SSE fallback required for Claude.

---

## Agent-first UX (real Claude)

Operator confirmed: OAuth completed, returned to Claude, `get_identity` and `create_test_item` worked, natural connector experience functioning.

| Question | Observation |
|---|---|
| Conversational onboarding from this client? | Partial. Connector add + one browser login/consent is required. After that, tools run in the same Claude conversation. Spike has no `create_identity` (hardcoded test principal). |
| Unavoidable browser redirects? | Yes: authorization + consent (`/interaction/{uid}` → “Continue as Test Jake”). Expected for OAuth. |
| Return to the same AI conversation after OAuth? | Yes — callback returns to Claude; connector shows connected. |
| Write-tool confirmation friction? | Acceptable in this spike. `create_test_item` is a single coarse write. Keep product writes coarse (baseline). |
| Multiple AN tools in one conversation? | Yes — read then write in the same connector session. |
| ChatGPT | Not tested. |

**Workaround recorded:** in-memory AS. Every Railway restart/redeploy invalidates registered clients. Remove and re-add the Claude connector after deploys until Phase 0 persists oidc-provider state.

---

## Defects found and fixed during -1 (do not regress)

1. **Missing `PUBLIC_URL`** → issuer `http://localhost:8080` and MCP `403 Invalid Host`. Set Railway `PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}` (and `COOKIE_KEYS`).
2. **Infinite consent loop** — `finishLogin` granted a hardcoded OIDC scope set; requested `identity:read` / `interactions:write` stayed missing (`op_scopes_missing`). Symptom: post-consent URL changed to a **new** `/interaction/...` and never returned to Claude. Consent now grants `missingOIDCScope` / claims / resource scopes plus requested indicators.
3. **Missing `scope` param** → `access_denied` before consent. Authorization endpoint defaults advertised scopes.

---

## Investigation log (kept as evidence)

### 2026-08-16 — first HTTPS smoke (failed, host/issuer)

| Check | Result |
|---|---|
| `GET /health` | **403** `Invalid Host: reachmyai-production.up.railway.app` |
| Protected-resource metadata | **403** same |
| Authorization-server metadata | 200, `"issuer":"http://localhost:8080"` |

### 2026-08-17 — after Railway variables (discovery pass)

`PUBLIC_URL` + unique `COOKIE_KEYS`. `/health` 200 with public issuer. Unauthenticated `POST /mcp` → 401 + `WWW-Authenticate` resource metadata.

### 2026-08-17 — consent loop, then production smoke

Reproduced with `scripts/oauth-smoke.mjs`. After `80c16d8` against production: DCR → consent → code to `https://claude.ai/api/mcp/auth_callback` → token JWT (`sub` / `principal_id` / `aud`) → MCP initialize, `get_identity`, `create_test_item` → refresh rotation → MCP again. All 200.

---

## Phase 0 inputs (from this spike only)

- Keep streamable HTTP MCP + in-process `oidc-provider` + PKCE + resource indicators.
- Persist oidc-provider adapter (clients, grants, sessions, tokens). Memory adapter is Phase -1 only.
- Map MCP `sub` = `accounts.id` (UUID). Never email.
- `agent_connections`: one row per grant/installation; uniqueness off grant/`oauth_client_id`, not provider.
- Provider label is metadata only.
- Website remains bootstrap/auth/consent/security; Claude proved the AI-as-interface path.

ChatGPT remains optional (V-1b). Not required to start Phase 0.
