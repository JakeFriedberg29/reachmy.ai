# Phase 3 — ReachMy Portal + frictionless provider onboarding

**Status:** **Approved** (2026-08-20, amended). Ready for implementation per slices in §19.

**Canonical index:** [`docs/implementation-plan.md`](../implementation-plan.md)  
**Approved direction:** [`phase3-portal-notes.md`](phase3-portal-notes.md)  
**Phase 2 gate:** [`docs/phase2-validation.md`](../phase2-validation.md) — complete; do not reopen unless a dependency appears during implementation.

**Product term:** **ReachMy Portal** (`app.reachmy.ai`). Never “Control Center”. Code uses `portal*` prefixes.

---

## 1. Phase goal

Ship the minimum authenticated **ReachMy Portal** at `https://app.reachmy.ai` so a human can:

1. Sign in once (Clerk).
2. See Agent Name state (**claimed** or **Not claimed yet**).
3. Connect Claude and/or ChatGPT with the least friction each provider supports today.
4. See **Your AI Connections** (Claude / ChatGPT, Connected / not connected) without internal OAuth leakage.
5. **Disconnect** an AI connection with explicit browser confirmation (reuse domain revoke).
6. Return to daily use inside Claude or ChatGPT — the Portal is not the primary product.

**Hard constraints (locked):**

| Constraint | Value |
|---|---|
| MCP resource | `https://mcp.reachmy.ai/mcp` (unchanged) |
| OAuth issuer / `PUBLIC_URL` | `https://mcp.reachmy.ai` (unchanged) |
| Marketing site | `reachmy.ai` (Framer, unchanged) |
| Portal | `app.reachmy.ai` (new custom domain on same Railway service) |
| Per-user MCP URLs | Forbidden |
| Daily workflow UI on Portal | Forbidden (inbox, messaging, proposals, scheduling, chat, activity feed) |

---

## 2. Locked product principles

1. **Claude and ChatGPT remain the daily interface.** Portal is setup, connections, security, and recovery only.
2. **Agent Name claiming is AI-first.** Portal shows **Not claimed yet**; Connect is not blocked before claim. After connection, the user must be able to claim their Agent Name **conversationally from Claude/ChatGPT** (Phase 3 requirement). Provider auto-prompting (“Let's choose your Agent Name.”) is desired but not a hard Phase 3 dependency (see §8.3).
3. **User-facing language only:** Agent Name, Your AI Connections, Connect Claude, Connect ChatGPT, Connected, Disconnect.
4. **Hide implementation terms** from standard users: MCP, OAuth client, grant, principal, tool IDs, `agent_connection_id`, raw OAuth metadata.
5. **Single app, role-based admin:** `app.reachmy.ai/admin` — backend-enforced; no `user.` / `admin.` hostnames.
6. **Provider metadata is descriptive only** — never used for authorization (already true in domain code). Inference may select UI/action targets only **after** connections are scoped to the authenticated account; it must never expand authorization or expose another account's connections.
7. **Disconnect ≠ delete account.** Revoke AI grant(s) for a provider; Agent Name, account, principal, and other AI connections remain.

---

## 3. Current implementation inventory (reuse)

### 3.1 Deployable unit

| Item | Location | Notes |
|---|---|---|
| Single Node/Hono process | `src/index.ts`, `src/server.ts` | REST + MCP + OAuth AS + Clerk + Neon |
| Config | `src/config.ts` | `PUBLIC_URL`, `allowedHosts`, `COOKIE_KEYS`, Clerk keys |
| Migrations | `drizzle/0000_phase0.sql`, `src/db/migrate.ts` | One migration today |

### 3.2 Authentication (today)

| Piece | Location | Behavior |
|---|---|---|
| Clerk JWT verify | `src/auth/clerk.ts` | `verifyClerkJwt`, `clerkFrontendApi` |
| ReachMy session cookie | `src/auth/session-cookie.ts` | `an_session` — HMAC, host-only, 7d, `SameSite=Lax`, no `Domain` |
| Account resolution | `src/http/context.ts` | Bearer Clerk JWT → `upsertAccountByClerkUser`; else `an_session` → account UUID |
| Clerk → session bridge | `POST /v1/auth/clerk` | `src/http/v1.ts` — sets `an_session` on **response host** |
| Browser sign-in page | `src/web.ts` `renderSignIn` | Clerk JS mount; POST token; redirect |
| OAuth human step | `src/web.ts` `handleInteraction` | Requires `an_session` on **mcp host**; else redirect `/sign-in` |
| OAuth completion | `src/auth/oidc.ts` `completeOauthInteraction` | Maps grant → `accountId` (UUID `sub`) |

**Gap (Phase 3 driver):** Portal sign-in on `app.reachmy.ai` sets `an_session` only on `app`. Claude/ChatGPT OAuth consent runs on `mcp.reachmy.ai` and cannot see that cookie. Phase 3 closes this with **Clerk Production subdomain session sharing + MCP Clerk bridge** (§7).

### 3.3 Identity & connections (domain)

| Function | Location | Reuse for Portal |
|---|---|---|
| `upsertAccountByClerkUser` | `src/domain/identity.ts` | Account find/create on Portal sign-in |
| `getIdentityByAccountId` | `src/domain/identity.ts` | Agent Name / onboarding state |
| `createIdentity` | `src/domain/identity.ts` | AI-first claim path — **must be extended** for provisional principal (§8.2) |
| `listConnections` | `src/domain/identity.ts` | Raw rows — **do not expose to browser** |
| `isApiConnection` | `src/domain/identity.ts` | Filter internal `api:{principalId}` connections |
| `upsertGrantConnection` | `src/domain/identity.ts` | OAuth grant → `agent_connections` (reuse) |
| `revokeAgentConnection` | `src/domain/connections.ts` | **Disconnect** (reuse verbatim) |
| `publicAgentConnection` | `src/domain/connections.ts` | Still too leaky for Portal — do not reuse for Portal API |

### 3.4 HTTP API (today)

| Route | Auth | Portal-safe? |
|---|---|---|
| `POST /v1/auth/clerk` | Clerk JWT | Yes — reuse; extend for Portal host + logout |
| `GET /v1/me` | account | Partial — identity shape OK |
| `GET /v1/identities/me` | account | Yes — Agent Name state |
| `GET /v1/connections` | actor (requires principal) | **No** — exposes grant/client fields via raw rows |
| MCP `revoke_agent_connection` | OAuth grant | Backend capability; Portal uses HTTP revoke instead |

### 3.5 OAuth / MCP (unchanged issuer)

| Piece | Location |
|---|---|
| OIDC provider | `src/auth/oidc.ts` |
| DCR | `POST /reg` |
| MCP endpoint | `POST /mcp` |
| Token verify + connection upsert | `src/auth/verify-token.ts` |
| Client metadata store | `oauth_models` (`model='Client'`, `payload.client_name`, `redirect_uris`) |

Production provider fingerprints (Phase 2):

- **Claude:** `client_name=Claude`, redirect `https://claude.ai/api/mcp/auth_callback`
- **ChatGPT:** `client_name=ChatGPT`, redirect `https://chatgpt.com/connector/oauth/{id}` (per connector, DCR)

### 3.6 Existing browser surfaces (bootstrap — not Portal)

On `mcp.reachmy.ai` only today: `/sign-in`, `/security`, `/invite/:token`, `/interaction/*`.  
`/security` lists connections including grant prefixes — **not** Portal-quality. **Locked:** leave temporarily as internal/bootstrap fallback; revisit removal/redirect after Portal production validation.

### 3.7 Tests to extend

| Suite | Coverage |
|---|---|
| `tests/phase1.test.ts` | Revoke without deleting Agent Name; MCP lifecycle |
| `tests/phase0.test.ts` | Domain core |
| `scripts/phase1-smoke.ts` | OAuth + MCP smoke |

---

## 4. Target architecture

```text
                         reachmy.ai (Framer — not Clerk-authenticated)
                               │
                    Get Started / Sign In  →  app.reachmy.ai only
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Railway — single Node/Hono service (unchanged deploy unit) │
│                                                               │
│  app.reachmy.ai                    mcp.reachmy.ai              │
│  ├─ Portal UI (Hono HTML/JS)       ├─ POST /mcp               │
│  ├─ /admin (403 or stub)           ├─ OAuth AS (/auth, …)    │
│  ├─ /v1/portal/* (browser APIs)    ├─ /interaction (consent)  │
│  └─ Clerk sign-in                  └─ PUBLIC_URL / issuer      │
│                                                               │
│  Shared: Neon, domain services, Clerk app, COOKIE_KEYS        │
└──────────────────────────────────────────────────────────────┘
                               │
              Claude / ChatGPT (daily UX — unchanged)
```

**Locked:** Same Railway Node/Hono service, host-based routing, no separate Next.js app.

---

## 5. Host / domain architecture

### 5.1 Host-based routing

Add `PORTAL_HOST` env (default `app.reachmy.ai`; local dev uses same process on `localhost` — see §19 slice 0).

Early middleware (before routes):

```text
requestHost = Host header (no port in prod)

if requestHost == PORTAL_HOST:
  → Portal router (/, /admin, /account, /v1/portal/*, Portal /sign-in, /sign-out)
else if requestHost in allowedHosts (mcp, railway default, localhost):
  → existing MCP/OAuth/API router (unchanged paths)
else:
  → 421 or 404 (fail closed)
```

**MCP/OAuth routes stay on mcp host only** — do not mount `/mcp` or `/auth` on `app.reachmy.ai`.

### 5.2 Config changes (`src/config.ts`)

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | Remains `https://mcp.reachmy.ai` in production |
| `PORTAL_URL` | `https://app.reachmy.ai` — redirects, CSRF Origin check, Clerk allowed origins |
| `PORTAL_HOST` | `app.reachmy.ai` — host routing |
| `allowedHosts` | Add `app.reachmy.ai` + keep `mcp.reachmy.ai`, Railway default, localhost |

### 5.3 Railway custom domain (operator steps)

1. Railway → ReachMy service → **Settings → Networking → Custom Domain**.
2. Add **`app.reachmy.ai`** (in addition to existing `mcp.reachmy.ai`).
3. **DNS:** `CNAME app` → Railway-provided target (DNS-only if using Cloudflare during TLS verification).
4. Wait for Railway TLS provisioned.
5. Set env: `PORTAL_URL=https://app.reachmy.ai`; ensure `allowedHosts` includes `app.reachmy.ai`.
6. **Do not change** `PUBLIC_URL`.

### 5.4 TLS expectations

- Railway terminates TLS for both custom domains on the same service.
- Framer continues to serve `reachmy.ai` separately.
- No TLS changes to `mcp.reachmy.ai`.

### 5.5 Clerk Production + subdomain security (required before Portal production launch)

**Locked:** Clerk **Production** with root domain **`reachmy.ai`** before Portal production launch.

Clerk [documents](https://clerk.com/docs/guides/development/deployment/production#authentication-across-subdomains) that with a production root domain, **sessions are shared across subdomains** (`app.reachmy.ai`, `mcp.reachmy.ai`). This is **not** satellite-domain setup.

#### 5.5.1 Clerk Dashboard configuration

| Setting | Required value / action |
|---|---|
| Root domain | `reachmy.ai` — complete Clerk DNS records as instructed |
| Production keys | `pk_live_` / `sk_live_` on Railway |
| **Subdomain allowlist** | Restrict Frontend API to ReachMy application subdomains that genuinely need auth |
| **`authorizedParties`** | Allow only origins that perform Clerk-authenticated browser flows: `https://app.reachmy.ai`, `https://mcp.reachmy.ai` |
| **`reachmy.ai` (Framer)** | **Do not** add to authenticated Portal behavior. Marketing links out to `app.reachmy.ai`; Framer is not a Clerk satellite/sign-in surface for Phase 3 |
| Social OAuth | Re-create provider credentials for Production |
| Framer | “Get Started” / “Sign In” → `https://app.reachmy.ai` only |

#### 5.5.2 Request verification impact

| Surface | Verification |
|---|---|
| **Portal (`app.reachmy.ai`)** | Clerk JS on Portal pages; `POST /v1/auth/clerk` verifies Clerk JWT via `@clerk/backend` `verifyToken`; sets host-scoped `an_session`. Clerk `authorizedParties` must include `https://app.reachmy.ai`. |
| **MCP OAuth consent (`mcp.reachmy.ai`)** | MCP Clerk bridge (§7.3) reads Clerk session from shared subdomain cookie and verifies JWT server-side before minting `an_session`. `authorizedParties` must include `https://mcp.reachmy.ai`. |
| **Portal mutations** | Session + CSRF + Origin check against `PORTAL_URL` (§12.2) — independent of Clerk party list but same origin discipline. |
| **MCP / OAuth AS** | Unchanged grant-scoped bearer tokens; no Portal CSRF on AI-initiated OAuth. |

**Development:** Subdomain sharing does not apply on `localhost`. Local cross-host inconvenience alone does **not** justify building production handoff infrastructure (§7.4). Test SSO against staging/production subdomains or accept manual second sign-in locally.

### 5.6 Deployment sequencing

| Order | Action | Rollback |
|---|---|---|
| 1 | Merge Phase 3 code with host routing; deploy (Portal dormant until DNS) | Revert deploy |
| 2 | Run DB migration (`platform_role` only) | Down migration script |
| 3 | **Clerk Production** + subdomain allowlist + `authorizedParties` | Keep Development keys until verified |
| 4 | Add Railway `app.reachmy.ai` + DNS CNAME | Remove CNAME; MCP unaffected |
| 5 | Set `PORTAL_URL`, verify `/health` on both hosts | Unset env |
| 6 | Framer link update | Revert Framer link |
| 7 | Production validation (§17) | Disable `app` DNS or revert |

---

## 6. Portal route map

### 6.1 User-facing pages (`app.reachmy.ai`)

| Route | Auth | Purpose |
|---|---|---|
| `GET /` | Required | Portal home — Agent Name + Your AI Connections |
| `GET /sign-in` | Public | Clerk sign-in; redirect → `/` or `?return=` |
| `POST /sign-out` | Session | Clear `an_session`; Clerk sign-out; redirect `/sign-in` |
| `GET /connect/claude` | Required | Claude prefilled install flow (§10) |
| `GET /connect/chatgpt` | Required | ChatGPT guided setup page (§11) |
| `GET /account` | Required | Minimal account / security (sign-out, recovery link) |
| `GET /admin` | Admin | Platform admin entry — **403 stub** for non-admin |

### 6.2 Portal components (Hono HTML + minimal JS)

| Component | Responsibility |
|---|---|
| `portalLayout` | Header “ReachMy”, nav (Home, Account), sign-out |
| `portalHome` | Agent Name block + connection list + Connect actions |
| `portalConnectionRow` | Provider label, Connected badge, Disconnect button |
| `portalDisconnectModal` | Confirmation copy (§12) |
| `portalSignIn` | Clerk mount (adapt `renderSignIn`) |
| `portalConnectClaude` | Explain steps + external link to Claude prefilled URL |
| `portalConnectChatGPT` | Numbered alpha steps + MCP URL copy box |
| `portalAdminStub` | “ReachMy admin” + proof of access for admins only |
| `portalForbidden` | 403 page for `/admin` |

---

## 7. Authentication & session architecture

### 7.1 Session ownership

| Session | Owner | Scope | Purpose |
|---|---|---|---|
| Clerk session | Clerk | `.reachmy.ai` (Production root domain) | Human identity; shared across `app` + `mcp` subdomains |
| `an_session` | ReachMy | Host-scoped per subdomain | ReachMy account UUID for Hono `requireAccount` / OAuth consent |
| OAuth AS cookies | oidc-provider | `mcp.reachmy.ai` only | Authorization interaction state |
| AI access tokens | ReachMy AS | Bearer | Claude/ChatGPT MCP — unchanged |

### 7.2 Sign-in flow (Portal)

```text
User → app.reachmy.ai/sign-in
  → Clerk UI (Google/email)
  → Clerk.session.getToken()
  → POST app.reachmy.ai/v1/auth/clerk { token }
  → upsertAccountByClerkUser
  → Set-Cookie an_session (on app host)
  → Redirect /
```

Reuse `POST /v1/auth/clerk` logic; Portal host may use a thin alias that delegates to the same handler.

### 7.3 Primary SSO: Clerk subdomain sharing + MCP Clerk bridge

**Phase 3 implements this only.** No signed handoff tickets or `portal_handoff_nonces` by default.

When OAuth opens `mcp.reachmy.ai/interaction/...`, resolve the human account via shared helper `resolveBrowserAccountId(req, config, db)`:

1. If valid `an_session` on mcp → use account UUID.
2. Else if valid **Clerk session** (subdomain cookie present) → `verifyClerkJwt` → `upsertAccountByClerkUser` → mint `an_session` on mcp → continue.
3. Else → redirect `mcp.reachmy.ai/sign-in?redirect=/interaction/{uid}` (existing fallback).

Implement bridge in `handleInteraction`, `renderSignIn` post-auth path, and any mcp browser entry that today requires `an_session` alone.

**Connect Claude / ChatGPT:** User may be signed into Portal on `app` only. When the provider initiates OAuth on `mcp`, the Clerk bridge should recognize the shared Clerk session and avoid a second Google/email prompt. No pre-OAuth handoff redirect is required in the default architecture.

### 7.4 Conditional fallback: signed handoff ticket (not in initial scope)

Implement **only if** production validation shows Clerk subdomain sharing + MCP bridge does **not** deliver the required SSO experience, **or** a demonstrated runtime requirement cannot be handled otherwise.

Local development inconvenience **alone** is not sufficient justification.

If triggered later, design spec (for reference only until needed):

| Item | Spec |
|---|---|
| Mint | Authenticated Portal endpoint → signed ticket URL on mcp |
| TTL | ~60 seconds, single-use nonce storage |
| Redeem | mcp endpoint sets `an_session` and redirects |

Do **not** add `portal_handoff_nonces` migration or handoff routes in initial Phase 3 slices.

### 7.5 Expiration & logout

| Event | Behavior |
|---|---|
| `an_session` expiry | 7 days (unchanged); re-auth via Clerk on next visit |
| Portal sign-out | Clear `an_session` on app; Clerk `signOut()` (clears subdomain session) |
| MCP `an_session` after sign-out | Orphaned until expiry; OAuth re-auth mints fresh cookie via Clerk bridge |

### 7.6 OAuth when user is not signed into Portal

```text
Claude/ChatGPT initiates OAuth (user skipped Portal)
  → mcp /interaction
  → no an_session, no Clerk session
  → redirect mcp /sign-in?redirect=/interaction/{uid}
  → Clerk sign-in → POST /v1/auth/clerk → an_session on mcp
  → OAuth consent → grant created
```

Existing mcp-only path; unchanged fallback.

---

## 8. Account / principal / Agent Name behavior

### 8.1 Lifecycle (locked)

```text
account
  → provisional principal (no handle)
  → AI connection(s) on that principal
  → create_identity (conversational, from Claude/ChatGPT)
  → handle added to SAME principal
```

Exactly **one** personal principal per account at all times.

### 8.2 Current `createIdentity` behavior (inspected — requires change)

**File:** `src/domain/identity.ts`

Today `createIdentity(db, accountId, { handle, displayName })`:

1. Loads identity via `identityFromAccount`.
2. If `identity.principal_id` is **already set** → throws `conflict("An Agent Name already exists for this account")` — **regardless of whether a handle exists**.
3. Else inserts a **new** `principals` row + `handles` row + `ensureApiConnection`.

**Implication:** With `ensureProvisionalPrincipal`, a provisional principal (no handle) would cause `createIdentity` to **fail** today. The MCP `create_identity` tool (`src/mcp/tools.ts`) calls `createIdentity` directly; it only short-circuits when `onboarding === "complete"` **and** `principalId` is set — a provisional user has `principalId` but `onboarding === "ONBOARDING_REQUIRED"`, so it still reaches the failing `createIdentity` path.

**Required Phase 3 change to `createIdentity`:**

| Condition | Action |
|---|---|
| No principal | Insert principal + handle + `ensureApiConnection` (**existing behavior**) |
| Principal exists, **no handle** (provisional) | Insert handle on **existing** `principal_id`; optionally update `displayName`; call `ensureApiConnection`; return identity — **idempotent** if handle already matches |
| Principal exists, **handle present** | `conflict` — Agent Name already claimed |

**`ensureProvisionalPrincipal(db, accountId)`** (new):

- If account has no principal: insert `principals` with `displayName` from Clerk email or `"ReachMy user"`.
- Do **not** insert `handles` row.
- Idempotent if principal already exists.
- Invoke from OAuth consent completion (`completeOauthInteraction`) and MCP Clerk bridge path before `upsertGrantConnection`.

**Grant binding:** After provisional principal exists, `upsertGrantConnection` attaches AI OAuth grants to that principal. `verify-token.ts` already upserts on token use when `principal_id` exists.

### 8.3 Agent Name onboarding expectations

| Category | Requirement |
|---|---|
| **Phase 3 hard requirement** | After Connect + OAuth, user can claim Agent Name **conversationally** via `create_identity` in Claude or ChatGPT (MCP tool). Portal shows **Not claimed yet** until handle exists. |
| **Desired UX (non-blocking)** | Provider automatically opens/prompts “Let's choose your Agent Name.” — investigate and record per provider; do **not** block Phase 3 if ReachMy cannot reliably trigger provider conversation behavior. |
| **Phase 4** | Headless conversational UX may improve onboarding prompts (`docs/plans/conversational-ux.md`). |
| **Portal claim form** | **No** for Phase 3 (locked). |

### 8.4 Portal display states

| State | DB | Portal display |
|---|---|---|
| New Clerk user | `accounts` only | Signed in; connections empty |
| After Connect, before claim | `accounts` + provisional `principals` + `agent_connections` | **Not claimed yet**; provider **Connected** |
| Claimed | `handles` row on same principal | `@jakebotberg` |
| Disconnect provider | All active grants for provider → `revoked` | Provider → Connect; Agent Name unchanged |

### 8.5 Automated tests required (provisional + createIdentity)

Add to Phase 3 test suite:

| Test | Assert |
|---|---|
| New account → provisional principal | `ensureProvisionalPrincipal` creates exactly one principal, no handle, `onboarding: ONBOARDING_REQUIRED` |
| AI connection on provisional principal | `upsertGrantConnection` binds grant to provisional `principal_id` |
| Claim on same principal | `createIdentity` adds handle to **existing** principal; `principal_id` unchanged |
| One principal invariant | Account never has two principals |
| Already-claimed user unchanged | Existing `createIdentity` conflict path when handle exists; no regression for `@jakebotberg`-style accounts |
| Idempotent claim | Repeated `createIdentity` with same handle on provisional principal succeeds or no-ops safely |

---

## 9. AI connection listing model

### 9.1 Domain helper

`listPortalAiConnections(db, accountId)` in `src/domain/portal-connections.ts`:

1. Load identity via `getIdentityByAccountId` (scoped to authenticated account).
2. If no `principal_id`, return disconnected provider placeholders.
3. `listConnections(principalId)` → filter `isApiConnection`.
4. Join `oauth_models` (`model='Client'`) for descriptive inference only.
5. Aggregate by provider; one UI row per provider.
6. Keep `connectionIds` server-side for disconnect — **never in browser JSON**.

**Authorization rule:** All connection rows must belong to the session account's principal before inference runs. Inference selects display labels and disconnect targets only within that scoped set.

### 9.2 Portal API response

`GET /v1/portal/overview` (session auth):

```json
{
  "agent_name": "@jakebotberg",
  "agent_name_status": "claimed",
  "connections": [
    { "provider": "claude", "label": "Claude", "status": "connected" },
    { "provider": "chatgpt", "label": "ChatGPT", "status": "not_connected" }
  ]
}
```

### 9.3 Why not raw `/v1/connections`

Exposes `grant_id`, `oauth_client_id`, UUIDs; requires onboarded actor.

---

## 10. Claude install flow

### 10.1 Prefilled custom connector URL

```text
https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=ReachMy&connectorUrl=https%3A%2F%2Fmcp.reachmy.ai%2Fmcp
```

User confirms in Claude. OAuth is not bypassed.

### 10.2 Portal UX sequence

```text
Portal home → [Connect Claude]
  → GET /connect/claude
  → Page: short copy + "Continue in Claude" (target=_blank) → prefilled URL
  → User confirms in Claude → OAuth on mcp.reachmy.ai
  → Clerk bridge → consent → provisional principal + agent_connection
  → User returns to Claude → claim Agent Name conversationally when ready
```

No handoff ticket step in default flow.

---

## 11. ChatGPT install flow (alpha)

Guided manual steps on `GET /connect/chatgpt`:

1. Developer Mode
2. Add custom MCP — Name: `ReachMy`, URL: `https://mcp.reachmy.ai/mcp`
3. Complete OAuth on mcp (Clerk bridge applies)
4. Enable ReachMy per conversation
5. Note tool refresh / new chat may be needed

No ChatGPT-specific domain logic. Future directory/plugin replaces page content only.

---

## 12. Disconnect / revoke flow

### 12.1 UX (locked)

```text
Claude    Connected    [ Disconnect ]
  → Modal: Disconnect Claude from @jakebotberg?
           Claude will immediately lose permission to act through ReachMy.
           (If multiple active Claude grants: "This will disconnect all Claude sessions.")
    [ Cancel ]  [ Disconnect ]
```

If unclaimed: “Disconnect Claude from your ReachMy account?”

### 12.2 API + CSRF (locked implementation)

`POST /v1/portal/connections/:provider/disconnect`

| Control | Implementation |
|---|---|
| Method | **POST only** for all Portal mutations |
| Session | Valid `an_session` or Clerk JWT → account (existing `requireAccount`) |
| **CSRF token** | Server generates per-session token; embedded in disconnect form / JS; sent as `X-CSRF-Token` header or `_csrf` form field; validated with timing-safe compare |
| **Origin check** | `Origin` header must match `PORTAL_URL` exactly (`https://app.reachmy.ai`; localhost allowed in dev config) |
| Authorization | Resolve provider → **all active** non-API connection IDs for authenticated principal; `revokeAgentConnection` for each |
| UI confirmation | Required for UX; **not** sufficient alone — backend checks above still mandatory |

**Locked:** Disconnect step-up re-auth **deferred** to `docs/plans/security-privacy.md`. Phase 3 = explicit confirmation modal + backend authorization only.

### 12.3 Domain reuse

`revokeAgentConnection(db, actor, connectionId)` unchanged — revokes grant, releases inbox claims, preserves Agent Name.

---

## 13. Admin role / schema / authorization

Migration `0001_platform_role.sql`:

```sql
ALTER TABLE accounts
  ADD COLUMN platform_role text NOT NULL DEFAULT 'user';

ALTER TABLE accounts
  ADD CONSTRAINT accounts_platform_role_chk
  CHECK (platform_role IN ('user', 'admin'));
```

| Helper | Behavior |
|---|---|
| `requirePlatformAdmin(db, accountId)` | `platform_role === 'admin'` else 403 |
| `resolveHumanPortalAccountIdFromRequest` | Human Portal session only: `an_session` cookie or Clerk JWT bearer |
| `GET /admin` | 403 stub for users; minimal page for admin |

**Platform-admin invariant (locked):** Platform-admin privileges are **human Portal privileges** and are **never inherited by AI connections**. `/admin` and future `/v1/admin/*` require `resolveHumanPortalAccountIdFromRequest` → `requirePlatformAdmin`. MCP/OAuth AS access tokens (issuer `mcp.reachmy.ai`, audience `/mcp`) and script tokens (`anp1.*`) must **not** authorize admin routes — even when the underlying account has `platform_role=admin`.

**Locked:** First admin via **one-time manual SQL/script** promotion. No auto-promote by email. No Clerk metadata as source of truth.

---

## 14. Database migrations

| Migration | Phase 3 |
|---|---|
| `0001_platform_role` | **Yes** — required |
| `portal_handoff_nonces` | **No** — conditional fallback only (§7.4) |

No new provider column. Provisional principal uses existing `principals` / `handles` schema.

---

## 15. Security considerations

| Topic | Mitigation |
|---|---|
| Portal data leakage | Dedicated DTO; no grant/client/connection UUIDs in JSON |
| CSRF | POST-only mutations; explicit CSRF token; Origin = `PORTAL_URL` |
| Clerk subdomain attack surface | Subdomain allowlist + `authorizedParties` limited to `app` + `mcp` |
| Framer isolation | `reachmy.ai` not in Clerk authenticated Portal flows |
| Host header attacks | `allowedHosts` + portal host check |
| Admin bypass | Server-side `platform_role` only; human Portal session only (`resolveHumanPortalAccountIdFromRequest`); MCP/OAuth tokens never admin |
| Provider inference | Descriptive only; after account-scoped connection load |
| Disconnect | Backend-authorized revoke; UI confirm is additive |
| OAuth issuer drift | No `/auth`, `/mcp`, `/.well-known/*` on app host |

---

## 16. Testing strategy

### 16.1 Automated (Vitest)

| Test | Assert |
|---|---|
| `inferPortalProvider` | Claude/ChatGPT from fixture payloads |
| `listPortalAiConnections` | API filter; provider aggregation; account scoping |
| `requirePlatformAdmin` | user → 403; admin → pass |
| Provisional principal lifecycle | §8.5 cases |
| `createIdentity` on provisional principal | Handle on same principal; no second principal |
| Already-claimed regression | Existing users unchanged |
| Portal disconnect | CSRF + Origin rejection; successful revoke all provider grants |
| Admin human session | OAuth/MCP bearer for admin account → `/admin` 401; script bearer → 401 |
| Host routing | Portal paths rejected on wrong Host |
| Clerk bridge (unit/integration) | Clerk JWT → `an_session` on mcp without second sign-in mock |

**Not in initial scope:** Handoff ticket tests.

### 16.2 Production validation

See §17.

---

## 17. Production validation plan

| # | Check | Pass criteria |
|---|---|---|
| 1 | Framer → Portal | Get Started → `app.reachmy.ai/sign-in` |
| 2 | Clerk Production | Live keys; subdomain allowlist + `authorizedParties` configured |
| 3 | SSO | Portal sign-in → Connect Claude → OAuth on mcp **without** second Google/email |
| 4 | New user | **Not claimed yet**; Connect buttons work |
| 5 | Connect before claim | Provisional principal + Connected in Portal |
| 6 | AI-first claim | `create_identity` in Claude/ChatGPT → same principal gets handle; Portal shows Agent Name |
| 7 | Connect ChatGPT | Guided page → Connected |
| 8 | Overview safety | No grant/client/UUID leakage in JSON |
| 9 | Disconnect | Confirm → all Claude grants revoked; others + Agent Name remain |
| 10 | Admin | Non-admin `/admin` → 403 |
| 11 | Issuer | `https://mcp.reachmy.ai` unchanged |
| 12 | Regression | `pnpm test`, `pnpm typecheck` |

If check **#3 fails** after Clerk config is verified correct, evaluate conditional handoff fallback (§7.4) before other workarounds.

---

## 18. Locked Phase 3 decisions

| Decision | Locked value |
|---|---|
| Clerk Production timing | **Before Portal production launch** |
| SSO primary | **Clerk root-domain subdomain sharing + MCP Clerk bridge** |
| Handoff tickets | **Conditional fallback only** — not in initial implementation |
| Provisional principal | **Yes** — `ensureProvisionalPrincipal` |
| `createIdentity` | **Extend** to claim handle on existing provisional principal (§8.2) |
| Disconnect step-up | **Explicit confirmation only**; fresh re-auth deferred to security plan |
| Disconnect scope | **Revoke all active grants** for provider; confirmation copy when count > 1 |
| Provider labels | **Infer at read time**; do not persist new provider field |
| Portal Agent Name form | **No** for Phase 3 |
| First platform admin | **One-time manual SQL/script** |
| `/security` on mcp | **Leave temporarily**; revisit after Portal production validation |
| Topology | **Same Hono/Railway service** |
| `PUBLIC_URL` | **`https://mcp.reachmy.ai`** unchanged |

### Remaining open items (non-blocking)

| # | Item | Notes |
|---|---|---|
| 1 | **ChatGPT install polish ceiling** | How detailed the guided page must be before directory listing |
| 2 | **Conditional handoff** | Only if production SSO validation fails (§7.4, §17 #3) |
| 3 | **`/security` removal/redirect** | After Portal production validation |
| 4 | **Provider auto-prompt behavior** | Record Claude/ChatGPT observations; Phase 4 may improve |

---

## 19. Implementation sequence (small slices)

Execute in order.

| Slice | Scope | Exit |
|---|---|---|
| **0** | `PORTAL_HOST`, host router, `allowedHosts`, `PORTAL_URL`, health on app host | `/health` 200 on app host — **complete** |
| **1** | Migration `platform_role` + `requirePlatformAdmin` + `/admin` 403 stub | Admin gate tested — **complete** |
| **2** | `ensureProvisionalPrincipal` + **`createIdentity` provisional-path extension** + §8.5 tests | Connect-before-claim lifecycle green — **complete** |
| **3** | Clerk bridge: `resolveBrowserAccountId` in `handleInteraction` / mcp sign-in | SSO without handoff tickets — **complete** |
| **4** | `listPortalAiConnections` + `GET /v1/portal/overview` | Safe JSON — **complete** |
| **5** | Portal UI: sign-in, home, account + shared Portal style system | Sign-in on app host — **complete** |
| **6** | `/connect/claude` + prefilled URL (no handoff) | Claude E2E — **complete** |
| **7** | `/connect/chatgpt` guided page | Honest alpha steps |
| **8** | Disconnect modal + CSRF middleware + `POST /v1/portal/connections/:provider/disconnect` | Revoke all provider grants |
| **9** | Clerk Production + subdomain allowlist + `authorizedParties` + Railway `app` DNS + Framer link | Production validation §17 |
| **10** | `scripts/portal-smoke.ts` + `docs/phase3-validation.md` template | CI green |

**Do not start slice 9 until slices 0–8 pass locally.**

**Not in initial slices:** Handoff ticket system, `portal_handoff_nonces` table.

---

## 20. Explicit out of scope (Phase 3)

- Inbox, messaging, coordination, proposal, scheduling, chat UI
- Activity / audit feed
- Operational admin dashboard
- Portal Agent Name create/edit form
- Handoff ticket infrastructure (unless §7.4 triggered post-validation)
- ChatGPT directory/plugin submission
- Changing `PUBLIC_URL`, issuer, or per-user MCP URLs
- Persisting provider label column
- Removing `/security` on mcp (deferred)
- Resend, RLS, OpenClaw, A2A, Next.js Portal

---

## 21. Phase 3 exit criteria

- [x] Plan approved before coding (this document, amended 2026-08-20)
- [ ] Framer Get Started → `app.reachmy.ai` + Clerk Production
- [ ] Connect Claude and/or ChatGPT **before** Agent Name claim
- [ ] Provisional principal + claim on **same** principal
- [ ] Conversational claim via MCP `create_identity` works after Connect
- [ ] Safe connection overview; no OAuth leakage
- [ ] Disconnect: CSRF + backend revoke all provider grants; Agent Name remains
- [ ] `/admin` denied without `platform_role=admin`
- [ ] No forbidden daily-workflow UI
- [ ] MCP issuer/resource unchanged
- [ ] `docs/phase3-validation.md` at close

---

## 22. Decision log (Phase 3 plan)

| # | Decision |
|---|---|
| P3-1 | Same Railway Node/Hono service; host-based routing |
| P3-2 | `accounts.platform_role` (`user` \| `admin`, default `user`) |
| P3-3 | Portal browser API under `/v1/portal/*` |
| P3-4 | Provider labels inferred at read time; never for auth; account-scoped first |
| P3-5 | Claude prefilled `add-custom-connector` deep link |
| P3-6 | ChatGPT guided manual alpha |
| P3-7 | **SSO: Clerk Production subdomain sharing + MCP Clerk bridge only**; handoff conditional |
| P3-8 | Provisional principal + extended `createIdentity` for same-principal claim |
| P3-9 | Disconnect: confirm + CSRF + Origin; revoke all provider grants; no step-up re-auth |
| P3-10 | Clerk `authorizedParties` + subdomain allowlist: `app` + `mcp` only; not Framer apex |
| P3-11 | CSRF: POST-only mutations, explicit token, Origin = `PORTAL_URL` |
| P3-12 | Platform-admin is human Portal session only; MCP/OAuth/script bearer tokens never authorize `/admin` |

---

*End of Phase 3 plan. Implementation may begin per §19 after this amendment review.*
