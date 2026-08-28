# Phase 3 validation — Slice 9 production cutover (Jake)

**Date:** 2026-08-28  
**Canonical MCP host:** `https://mcp.reachmy.ai`  
**MCP resource:** `https://mcp.reachmy.ai/mcp`  
**Portal host:** `https://app.reachmy.ai`  
**Report:** this file  
**Gate:** Slice 9 (Jake Clerk Production cutover + production auth validation) closed. Slice 10 not started.

---

## Summary

Slice 9 production work validated **Clerk Production** on Railway, **Jake-only** Neon `clerk_user_id` remap, real Production Portal sign-in, identity continuity for `@jakebotberg`, and the **Portal → MCP Clerk bridge** without a second Google login.

Slices **0–8** were complete before this cutover. Slice **10** (`scripts/portal-smoke.ts`, expanded validation automation) remains the next implementation slice.

**Deferred operator item (Slice 9 plan table):** Framer `reachmy.ai` Get Started / Sign In links still point at their pre-Portal targets until updated manually. This does not block Slice 10 coding.

---

## Production infrastructure (verified)

| Item | Value / status |
|---|---|
| Railway service | Single ReachMy Node service (`mcp.reachmy.ai` + `app.reachmy.ai`) |
| `PUBLIC_URL` | `https://mcp.reachmy.ai` (unchanged) |
| `PORTAL_URL` / `PORTAL_HOST` | `https://app.reachmy.ai` / `app.reachmy.ai` |
| Clerk Production | `pk_live_` / `sk_live_` on active Railway deploy |
| Clerk application domain | `https://app.reachmy.ai` (root domain `reachmy.ai`) |
| Clerk Production user (Jake) | `user_3IWJr7h5jpvnmAs8DA3BJmnjAF1` (`jakefriedberg32@gmail.com`) |
| Neon production endpoint | `ep-tiny-violet-ayrr8l02` |
| Health | `https://mcp.reachmy.ai/health` → 200; `https://app.reachmy.ai/health` → 200 |

---

## Jake Clerk Production migration

### Neon remap (2026-08-28)

Atomic production transaction remapped **only** `accounts.clerk_user_id` for `@jakebotberg`:

| | Clerk user ID |
|---|---|
| Before (Dev) | `user_3I4GEMsFuxECI5ZDo0o7dAgvbuV` |
| After (Prod) | `user_3IWJr7h5jpvnmAs8DA3BJmnjAF1` |

**Preserved:** `account_id`, `principal_id`, Agent Name `@jakebotberg`, connected AI grants (3), relationship rows (1), interaction rows (3). Email remained `NULL` (acceptable).

Script: [`scripts/jake-clerk-production-cutover.sql`](../scripts/jake-clerk-production-cutover.sql)

### Railway Clerk key cutover

`CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` switched to Production `pk_live_` / `sk_live_` on the active deploy. Verified via page source on `https://app.reachmy.ai/sign-in`.

**Incident:** First key-update attempt did not apply to the serving deployment; page source still showed `pk_test_`. A second update to the active production service fixed this.

### Orphan account incident (resolved)

While Railway still served `pk_test_`, a Production Portal sign-in after the Neon remap created a **blank** ReachMy account:

| Field | Value |
|---|---|
| `account_id` | `4b88d007-80bc-4bc9-98fa-9191662446b1` |
| `clerk_user_id` | `user_3I4GEMsFuxECI5ZDo0o7dAgvbuV` (Dev ID) |
| State | No principal, no handle, no grants |

**Cause:** Dev Clerk JWT `sub` no longer matched canonical Jake after remap → `upsertAccountByClerkUser` inserted a new row.

**Resolution:** After Railway Production keys were live, Portal sign-in correctly resolved `@jakebotberg`. Orphan row deleted atomically in production Neon (2026-08-28). Canonical identity verified intact post-delete.

---

## Production validation results (Jake / Slice 9)

| # | Check (§17) | Result | Notes |
|---|---|---|---|
| 1 | Framer → Portal | **Deferred** | Operator update pending |
| 2 | Clerk Production | **Pass** | Live keys; subdomain allowlist + `authorizedParties` configured in Clerk |
| 3 | SSO (Portal → MCP) | **Pass** | Same browser: `app.reachmy.ai` signed in → `mcp.reachmy.ai/sign-in?redirect=/security` → no second Google; landed on `/security` with existing agents |
| 4–6 | New user / connect-before-claim / AI claim | **Not re-run in prod** | Covered by Slices 0–8 automated tests |
| 7 | Connect ChatGPT guided page | **Not re-run in prod** | Slice 7 complete in dev |
| 8 | Overview safety | **Pass** (Portal) | Jake Portal home shows user-facing labels only |
| 9 | Disconnect | **Not re-run in prod** | Slice 8 complete in dev |
| 10 | Admin 403 | **Not re-run in prod** | Slice 1 complete in dev |
| 11 | Issuer unchanged | **Pass** | `https://mcp.reachmy.ai` |
| 12 | Regression | **Pass** | `pnpm typecheck`; `pnpm test` 125/125 |

### Jake identity continuity (production Neon, post cutover)

| Field | Value |
|---|---|
| Agent Name | `@jakebotberg` |
| `account_id` | `ba0ec12a-4375-43c8-8be1-0e16b5c36269` |
| `principal_id` | `baad6069-94a1-400b-b7c8-33ec5c19a44a` |
| `clerk_user_id` | `user_3IWJr7h5jpvnmAs8DA3BJmnjAF1` |
| Connected AI grants | 3 |
| Relationship rows | 1 |
| Interaction rows | 3 |
| Duplicate `@jakebotberg` accounts | 0 |

### Portal production sign-in (2026-08-28)

- URL: `https://app.reachmy.ai/sign-in`
- Google: `jakefriedberg32@gmail.com`
- Result: Portal home — `@jakebotberg`, Claude **Connected**, ChatGPT **Connected**

---

## Slice status

| Slice | Scope | Status |
|---|---|---|
| 0–8 | Portal foundation through disconnect | **Complete** (deployed) |
| **9** | Clerk Production + Jake cutover + production auth validation | **Complete** |
| 10 | `portal-smoke.ts` + validation automation | **Not started** |

---

## Automated test results

Run 2026-08-28:

```text
pnpm typecheck   — pass
pnpm test        — 125/125 pass
```

---

## Known limitations / deferred

| Item | Plan |
|---|---|
| Framer marketing links → `app.reachmy.ai` | Out of scope — operator handles separately; not a Phase 3 blocker |
| Margot Clerk Production migration | Separate later cutover; out of scope for Jake Slice 9 |
| Full §17 new-user / disconnect prod re-validation | Accepted via Slices 0–8 automated coverage |
| `/security` on mcp host | Leave temporarily per Phase 3 plan |
| Conditional handoff tickets | Not required — subdomain Clerk bridge passed |

---

## Next step

Slice **10:** `scripts/portal-smoke.ts` and expand this validation report as Phase 3 approaches full close.
