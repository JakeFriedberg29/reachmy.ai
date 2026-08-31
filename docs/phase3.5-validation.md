# Phase 3.5 validation — current state (not fully closed)

**Date:** 2026-08-30  
**Canonical MCP host:** `https://mcp.reachmy.ai`  
**MCP resource:** `https://mcp.reachmy.ai/mcp`  
**Portal host:** `https://app.reachmy.ai`  
**Report:** this file  
**Gate:** Phase 3 remains **complete**. Phase 3.5 is **current** and **not fully closed**. Phase 4 has **not** started.

This is a current-state record after Slice 8 hygiene. It does **not** close Phase 3.5.

Plan: [`docs/plans/phase3.5-security-hardening.md`](plans/phase3.5-security-hardening.md).

---

## Slice status

| Slice | Scope | Status |
|---|---|---|
| 1 | Safe redirect helper | **Complete** |
| 2 | Fail-closed production `COOKIE_KEYS` | **Complete** |
| 3 | Shared HTTP test harness | **Complete** |
| 4 | Explicit OAuth consent | **Complete** (real-provider regression passed with Slice 5) |
| 5 | DCR policy + client metadata validation | **Complete** (real-provider regression passed with Slice 4) |
| 6a | Scope observability (report-only) + MCP transport diagnostics | **Complete** / deployed. ChatGPT `initial_authorization` captured; Claude `initial_authorization` still outstanding |
| 6b | Scope issuance + enforcement | **BLOCKED — not shipped.** Prototype only; production mapping rejected. Branch `prototype/phase3.5-slice6b-scope-enforcement` must not be merged |
| 7 | CI / lint / format / test discovery | **Complete** (merged `5071c89`, PR #1) |
| 8 | Documentation and repository hygiene | **Complete** (this record) |

---

## Production main and health (verified 2026-08-30)

| Item | Value |
|---|---|
| Local `main` / `origin/main` | `2f15f7ba59420a3a8cbef7630ffbcaf3d904109a` |
| Railway production SHA | `2f15f7b` (deploy `8a55ddff`, SUCCESS, Online) |
| `GET https://mcp.reachmy.ai/health` | **200** (`ok: true`, issuer `https://mcp.reachmy.ai`) |
| `GET https://app.reachmy.ai/health` | **200** (`ok: true`, `surface: portal`) |

`2f15f7b` is the Slice 7 docs-only follow-up (Decision 115). The Slice 7 application SHA remains `5071c89`. No runtime change was made to force SHA alignment.

Grant-rebind from `cf7b84a` (decision 105) **remains present** on production `main`.

---

## Connector evidence (narrow)

**Claude** was not modified during Phase 3.5 Slice 8 and was not used as a rollback subject. Existing Claude grant must not be revoked to force a fresh `initial_authorization`.

**ChatGPT** is not described here as generally broken or disconnected. The established evidence is narrower:

- A 2026-08-30 selective pre-Phase-3.5 rollback on `diagnostic/chatgpt-pre-phase3.5` (`fb6ea26`) did **not** restore ChatGPT tool exposure (decision 114).
- That diagnostic ruled out Slices 4, 5, and 6a as the cause of the current “no callable tools / no MCP traffic” symptom.
- ChatGPT recognized `@reachmy.ai` but exposed no callable tools. ReachMy received zero ChatGPT traffic (`/reg`, `/auth`, `/token`, `/mcp`, `oauth_debug`, `mcp_debug`, `openai-mcp` user-agent).
- The current ChatGPT connector-loading issue remains **unresolved upstream of ReachMy invocation**. No further ReachMy rollback is warranted for this symptom.
- The diagnostic branch was not merged. Production was restored to `main`.

---

## Hygiene performed in Slice 8

- Deleted untracked `scripts/remap-clerk-production-ids.sql` (never committed).
- Archived and sanitized the executed Jake Clerk cutover to `scripts/archive/jake-clerk-production-cutover.sql`.
- Replaced named handles in `scripts/inspect-production-identities.sql` with placeholders. Production DB safety in `src/config.ts` was not changed.
- Reconciled active docs so Phase 3 is complete, Phase 3.5 is current, Slice 6b is blocked, and Phase 4 is not started.

No OAuth, DCR, consent, scope, grant-rebind, TTL/refresh, `oauth_debug`, `mcp_debug`, or health-JSON behavior changed.

---

## What still blocks Phase 3.5 close

- Slice 6b remains blocked (decisions 96, 102, 103, 106–113).
- Fresh Claude `scope_authorization_observed` `initial_authorization` is still outstanding (gate 96 / decision 103).
- ChatGPT live validation is not a reliable 6b / close-out client while connector-loading remains unresolved upstream of ReachMy.
- Plan §8 still requires Claude and ChatGPT to connect and operate through ReachMy before Phase 3.5 can close.

Phase 4 has **not** started.
