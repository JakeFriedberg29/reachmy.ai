# Phase 3 validation — PASSED

**Date closed:** 2026-08-28  
**Canonical MCP host:** `https://mcp.reachmy.ai`  
**MCP resource:** `https://mcp.reachmy.ai/mcp`  
**Portal host:** `https://app.reachmy.ai`  
**Report:** this file  
**Gate:** Phase 3 closed. Phase **3.5** current. Phase 4 not started.

---

## Summary

Phase 3 delivered the **ReachMy Portal** at `app.reachmy.ai` on the same Railway service as MCP/OAuth, with host-based routing, Clerk Production auth, safe connection overview, Connect Claude/ChatGPT flows, disconnect with CSRF, and Jake-only Production Clerk cutover validated in production.

**Portal smoke:** `pnpm smoke:portal` (`scripts/portal-smoke.ts`) exercises Portal host health, sign-in, host isolation, MCP health, authenticated overview DTO safety, and non-admin `/admin` 403.

**Out of scope (not a Phase 3 blocker):** Framer marketing link updates — operator handles separately.

---

## Slice status

| Slice | Scope | Status |
|---|---|---|
| 0 | Host routing, Portal/MCP split, health | **Complete** |
| 1 | `platform_role`, `/admin` gate | **Complete** |
| 2 | Provisional principal, `createIdentity` extension | **Complete** |
| 3 | MCP Clerk bridge (`resolveBrowserAccountId`) | **Complete** |
| 4 | `listPortalAiConnections`, `/v1/portal/overview` | **Complete** |
| 5 | Portal UI (sign-in, home, account) | **Complete** |
| 6 | Connect Claude prefilled URL | **Complete** |
| 7 | Connect ChatGPT guided page | **Complete** |
| 8 | Disconnect modal + CSRF | **Complete** |
| 9 | Clerk Production + Jake cutover + production auth | **Complete** |
| 10 | `portal-smoke.ts` + this validation report | **Complete** |

---

## Phase 3 exit criteria mapping

| Criterion | Evidence |
|---|---|
| Plan approved | [`docs/plans/phase3-portal.md`](plans/phase3-portal.md) |
| Clerk Production before production Portal | Slice 9 production validation (Jake) |
| Portal at `app.reachmy.ai` | Deployed; health 200 |
| Connect Claude / ChatGPT before Agent Name claim | `tests/phase3-slice2.test.ts` |
| Provisional principal + same-principal claim | `tests/phase3-slice2.test.ts` |
| Conversational `create_identity` after Connect | `tests/phase3-slice2.test.ts`, MCP tools |
| Safe connection overview (no OAuth leakage) | `tests/phase3-slice4.test.ts`, `pnpm smoke:portal` |
| Disconnect: CSRF + revoke all provider grants | `tests/phase3-slice8.test.ts` |
| `/admin` denied without `platform_role=admin` | `tests/phase3-slice1.test.ts`, `pnpm smoke:portal` |
| No forbidden daily-workflow UI | Portal route map §6 (slices 5–8) |
| MCP issuer/resource unchanged | `pnpm smoke:portal`, production health |
| Framer → Portal links | **Out of scope** — operator handles separately |
| Validation report | This file |

---

## Portal smoke (`pnpm smoke:portal`)

Run 2026-08-28 — **10/10 checks pass:**

| Check | Result |
|---|---|
| Portal `/health` → 200, `surface=portal` | Pass |
| Unauthenticated `/` → redirect `/sign-in` | Pass |
| `/sign-in` renders ReachMy + Clerk bridge | Pass |
| Portal host blocks `/mcp` | Pass |
| Portal host blocks `/.well-known/oauth-authorization-server` | Pass |
| Portal host blocks `/.well-known/oauth-protected-resource` | Pass |
| Portal host blocks `/auth` | Pass |
| MCP `/health` → 200, `surface=mcp`, issuer unchanged | Pass |
| Authenticated `/v1/portal/overview` → safe DTO | Pass |
| Non-admin `/admin` → 403 | Pass |

Local only — uses development Neon via `.env`; production DB guard enforced by `loadConfig()`.

---

## Production infrastructure (verified)

| Item | Value / status |
|---|---|
| Railway service | Single ReachMy Node service (`mcp.reachmy.ai` + `app.reachmy.ai`) |
| `PUBLIC_URL` | `https://mcp.reachmy.ai` (unchanged) |
| `PORTAL_URL` / `PORTAL_HOST` | `https://app.reachmy.ai` / `app.reachmy.ai` |
| Clerk Production | `pk_live_` / `sk_live_` on active Railway deploy |
| Clerk application domain | `https://app.reachmy.ai` (root domain `reachmy.ai`) |
| Clerk Production user (Jake) | Production Clerk user (prefix `user_3IWJ…`) |
| Neon production endpoint | `ep-tiny-violet-ayrr8l02` |
| Health | `https://mcp.reachmy.ai/health` → 200; `https://app.reachmy.ai/health` → 200 |

---

## Jake Clerk Production migration (Slice 9)

### Neon remap (2026-08-28)

Atomic production transaction remapped **only** `accounts.clerk_user_id` for `@jakebotberg`:

| | Clerk user ID |
|---|---|
| Before (Dev) | `user_3I4G…` |
| After (Prod) | `user_3IWJ…` |

**Preserved:** `account_id`, `principal_id`, Agent Name `@jakebotberg`, connected AI grants (3), relationship rows (1), interaction rows (3).

Script (historical archive; sanitized; do not re-run): [`scripts/archive/jake-clerk-production-cutover.sql`](../scripts/archive/jake-clerk-production-cutover.sql)

### Railway Clerk key cutover

`CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` switched to Production `pk_live_` / `sk_live_` on the active deploy.

**Incident:** First key-update attempt did not apply to the serving deployment; page source still showed `pk_test_`. A second update fixed this.

### Orphan account incident (resolved)

While Railway still served `pk_test_`, a Production Portal sign-in after the Neon remap created a blank account (`4b88d007-…`, Dev Clerk ID). After Production keys were live, sign-in resolved `@jakebotberg` correctly. Orphan deleted atomically; canonical identity verified intact.

### Production validation (Jake)

| Check | Result |
|---|---|
| Portal sign-in → `@jakebotberg` | Pass |
| Claude + ChatGPT Connected | Pass |
| Neon continuity (8/8) | Pass |
| Portal → MCP Clerk bridge (no second Google) | Pass |
| MCP issuer | `https://mcp.reachmy.ai` — unchanged |

---

## Automated test results

Run 2026-08-28:

```text
pnpm typecheck     — pass
pnpm test          — 125/125 pass
pnpm smoke:portal  — 10/10 pass
```

---

## Known limitations / deferred

| Item | Plan |
|---|---|
| Framer marketing links | Out of scope for Phase 3 — operator handles separately |
| Margot Clerk Production migration | Separate later cutover |
| `/security` on mcp host | Leave temporarily per Phase 3 plan |
| Conditional handoff tickets | Not required — subdomain Clerk bridge passed |
| Full §17 new-user / disconnect prod re-validation | Accepted via automated Slice 0–8 tests + portal smoke |

---

## Next step

Phase **3.5** — security hardening and repository hygiene. Current-state record: [`docs/phase3.5-validation.md`](phase3.5-validation.md). Phase 4 (headless conversational UX) has **not** started and must not start until Phase 3.5 closes.
