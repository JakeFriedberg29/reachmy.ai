# Phase 2 validation — PASSED (with accepted limitations)

**Date:** 2026-08-20  
**Canonical host:** `https://mcp.reachmy.ai`  
**MCP resource:** `https://mcp.reachmy.ai/mcp`  
**Report:** this file  
**Gate:** Phase 2 closed. Phase 3 not started.

---

## Summary

Phase 2 proves ReachMy is **provider-neutral** for Claude and ChatGPT on the same production backend: same OAuth issuer/resource, same domain services, same Agent Name model, separate `agent_connections` per AI install, durable inbox, and cross-person COORDINATE over real MCP paths.

Production validation used **`@jakebotberg`** (Jake) and **`@margot_botberg`** (Margot) — two real Clerk-human accounts — not `@daniel`.

**Accepted operator decision:** Test B does not require Margot on Claude. Jake already has both providers on one Agent Name; Margot validated on ChatGPT only. Full proposal → approval → `AGREED` on the production two-person path was not executed end-to-end; that lifecycle is covered by automated MCP adapter tests over the same domain code.

No OAuth or domain architecture changes were required for ChatGPT interoperability.

---

## Agent Names and accounts (production)

| Person | Agent Name | Clerk human | Principal | AI connections (connected) |
|---|---|---|---|---|
| Jake | `@jakebotberg` | yes | one | API + **2× Claude** + **ChatGPT** |
| Margot | `@margot_botberg` | yes | one | API + **ChatGPT** |

- One Agent Name per person; Claude and ChatGPT are separate `agent_connections`, not identities.
- `provider` column is **null** on all rows; authorization does not branch on provider.
- Descriptive distinction only: OAuth `client_name` (`Claude` / `ChatGPT`) and redirect URI host (`claude.ai` / `chatgpt.com`).

---

## Test A — sequence and result

**Specified flow:** Jake / Claude → ReachMy → durable inbox → other person / ChatGPT → TIME proposal → Jake / Claude → approval → `AGREED`.

**Production actors:** `@jakebotberg` / `@margot_botberg` (substituted for `@daniel`).

### Steps validated in production

| Step | Provider path | Backend result |
|---|---|---|
| Relationship | Jake invite → Margot `accept_invite` (ChatGPT) | Active relationship; bidirectional messaging + scheduling |
| COORDINATE create | Jake / **Claude** → `@margot_botberg` | Interaction `PENDING`; intent “Just wanted to say hi!” |
| COORDINATE create | Jake / **ChatGPT** → `@margot_botberg` | Interaction `PENDING`; intent “How is wedding planning going?” |
| Durable inbox | (recipient offline at create) | Inbox item `unread` on `@margot_botberg` for each Jake-initiated interaction |
| Cross-provider write | Jake acts as same Agent Name from Claude and ChatGPT | Same principal; different `agent_connection_id` on events |
| Recipient create | Margot / **ChatGPT** → `@jakebotberg` | Interaction `PENDING`; inbox on Jake |

**Event attribution (descriptive only):**

- Jake COORDINATE via ChatGPT: `client_name=ChatGPT`, redirect `chatgpt.com`
- Jake COORDINATE via Claude: `client_name=Claude`, redirect `claude.ai`
- Margot COORDINATE via ChatGPT: `client_name=ChatGPT`

### Steps not run in production (accepted)

| Step | Status | Coverage |
|---|---|---|
| Margot TIME proposal on Jake-initiated interaction | Not observed in Neon | `tests/phase1.test.ts` — MCP adapter COORDINATE → TIME → AGREED |
| Jake Claude approval → `AGREED` | Not observed in Neon | Same automated test + Phase 0 domain tests |

**Test A result:** **PASSED** for cross-provider identity, relationship, COORDINATE, durable inbox, and offline recipient. Proposal/approval/`AGREED` accepted via automated suite on shared domain services (operator waiver for live two-person completion).

---

## Test B — sequence and result

**Specified flow:** Jake / ChatGPT → inbox → other person / Claude → TIME proposal → Jake / ChatGPT → approval → `AGREED`.

**Accepted limitation:** Margot does **not** have a Claude connection. Test B’s “recipient on Claude” leg is **not** production-validated for the second person.

**Rationale for acceptance:**

- Jake demonstrates **both** providers on one Agent Name (`@jakebotberg`).
- Margot demonstrates ChatGPT read/write and COORDINATE on production.
- Domain authorization is provider-blind (principal + grant + permissions only).
- Reverse-direction COORDINATE (Margot ChatGPT → Jake) succeeded in production.
- TIME proposal and approval from either provider use the same MCP tools and domain services (automated proof).

**Test B result:** **PASSED by acceptance** — symmetric architecture and automated lifecycle tests; Margot-on-Claude explicitly deferred.

---

## Provider-neutral authorization

Confirmed in code inspection and production behavior:

- No domain helper branches on `provider`, `client_name`, or redirect URI.
- `verify-token.ts` maps grant → `agent_connection`; revoked connections rejected regardless of AI.
- Interactions, inbox, proposals, and approvals key off **principal** and **relationship permissions** only.
- Provider metadata appears in OAuth client records and interaction event `agent_connection_id` linkage only.

---

## Durable inbox

- Inbox items created at COORDINATE time for the **recipient** principal.
- State `unread`, unclaimed, while recipient had not acted — proves offline survival at creation.
- Assignee on inbox rows points at each person’s **API** (primary) connection, not the MCP AI connection that created the interaction. Descriptive/assignment quirk only; does not block inbox listing via MCP tools.

---

## ChatGPT OAuth (production, no architecture change)

Recorded 2026-08-18 from live handshake:

| Item | Value |
|---|---|
| Registration | DCR (`POST /reg`); opaque `client_id`; CIMD not used |
| Redirect URI | `https://chatgpt.com/connector/oauth/{id}` (per connector) |
| PKCE | S256 required |
| Resource | `https://mcp.reachmy.ai/mcp` |
| Refresh | Issued; rotation enabled |
| agent_connection | New row per grant; `provider=null`, `display_label=MCP` |

Claude uses shared callback `https://claude.ai/api/mcp/auth_callback`. Same issuer, same domain API.

---

## Claude vs ChatGPT UX (observed, not solved)

| Area | Claude | ChatGPT |
|---|---|---|
| Install | Custom connector; URL `https://mcp.reachmy.ai/mcp` | Developer Mode; custom MCP/app; enable per conversation |
| OAuth | Browser consent on `mcp.reachmy.ai`; returns to Claude | Browser consent; returns to ChatGPT connector |
| Scope request | Often includes `offline_access` | Observed narrower initial scope; grant still receives full resource scopes |
| Identity | Same Agent Name after same Clerk account | Same Agent Name after same Clerk account |
| Tool use | Natural language → MCP tools | Natural language → MCP tools; may need explicit “use ReachMy” |
| display_label in DB | `MCP` | `MCP` — UI cannot distinguish from connection row alone |

Deferred to Phase 4 (`docs/plans/conversational-ux.md`) and Phase 3 install/onboarding notes.

---

## Automated test results

Run 2026-08-20:

```text
pnpm typecheck   — pass
pnpm test        — 11/11 pass (phase0.test.ts + phase1.test.ts)
```

Relevant automated coverage:

- COORDINATE → TIME → approve → **AGREED**
- Directional permission denies
- Invite single-use
- Concurrent inbox claim
- Approve/reject transactional + idempotent
- MCP adapter full lifecycle
- Revoke AI connection without deleting Agent Name

---

## Known limitations / deferred

| Item | Plan |
|---|---|
| Margot (second person) on Claude | Not required for Phase 2 close; optional later |
| Production two-person path to `AGREED` | Accepted via automated MCP tests |
| `@daniel` as test persona | Never provisioned; `@margot_botberg` used instead |
| Stale Jake Claude grant (pre-`mcp.reachmy.ai` hostname) | Extra connected row; use current Claude grant for daily use |
| Inbox assignee = API connection | Future UX/metadata improvement |
| `list_agent_connections` cannot label Claude vs ChatGPT | Infer from OAuth client at Portal time (Phase 3) |
| ChatGPT write smoke canvas | `phase2-oauth-inspection.canvas.tsx` (Cursor canvas, not repo doc) |

---

## Phase 2 exit criteria

| Criterion | Result |
|---|---|
| Cross-provider OAuth on `mcp.reachmy.ai` | Pass |
| Same Agent Name, separate `agent_connections` | Pass (`@jakebotberg`; Margot ChatGPT) |
| Provider-blind authorization | Pass |
| Durable inbox / offline recipient | Pass |
| COORDINATE across people and providers | Pass (production) |
| TIME proposal + approval → `AGREED` | Pass (automated; production waiver) |
| Test A | Pass (with waiver on live AGREED) |
| Test B | Pass (accepted; Margot Claude waived) |
| `docs/phase2-validation.md` | This file |
| Automated suites | Pass |
| Phase 3 not started | Pass |

---

## Next step (not executed here)

Write `docs/plans/phase3-portal.md` from [`docs/plans/phase3-portal-notes.md`](plans/phase3-portal-notes.md) and wait for approval before Portal coding.
