# ReachMy — Canonical Implementation Plan

**Status:** Canonical as of 2026-08-19 (Portal / admin / AI-first Agent Name). Supersedes `/Users/Jake/Downloads/AGENT_NETWORK_IMPLEMENTATION_PLAN.md` (Frozen V1, 2026-08-15) for product direction and near-term phase sequence.

**This revision is documentation only.** No application code until this plan is reviewed. After approval, resume **Phase 2 Tests A/B only**. Do not start Phase 3 coding until a dedicated Phase 3 plan (`docs/plans/phase3-portal.md`) is written and approved.

**Current execution state:** Phases -1, 0, 1, and **2** are complete. Report: [`docs/phase2-validation.md`](phase2-validation.md). **Phase 3 plan approved** (amended 2026-08-20): [`docs/plans/phase3-portal.md`](plans/phase3-portal.md). Implementation may begin per plan slices; do not skip approved gates (Clerk Production before production launch).

Shipped schema, OAuth issuer/resource, domain services, and MCP tools remain as implemented unless a later approved phase changes them. This document does not reopen Phase 0/1 architecture.

Future workstreams that are not the current phase belong in [dedicated plan files](plans/README.md), not in this index.

---

## 1. Product thesis

ReachMy is a **headless identity, relationship, permission, and durable-interaction network** underneath the AI the user already uses.

**Agent Name** is the only user-facing identity term (example: `@jake`). It should feel like a username. Claude and ChatGPT are AI connections that may represent an Agent Name. They are not the identity.

> Your AI is the interface. ReachMy is the network underneath it.

**Near-term platforms:** Claude and ChatGPT only.

**Three public hosts**

| Host | Role |
|---|---|
| `reachmy.ai` | Public marketing site (currently Framer). Not the product UI. |
| `app.reachmy.ai` | Single authenticated **ReachMy Portal** plus backend-protected `/admin`. Setup/connections/security only. **Not** a daily SaaS dashboard. |
| `mcp.reachmy.ai` | Existing MCP / OAuth AS / domain API. Canonical issuer and resource. Unchanged. |

There is **one** shared MCP endpoint: `https://mcp.reachmy.ai/mcp`. Users do not receive unique MCP URLs. Keep `PUBLIC_URL=https://mcp.reachmy.ai`. Introducing `app.reachmy.ai` must not change the issuer/resource.

**User-facing Portal language:** Agent Name, Your AI Connections, Connect Claude, Connect ChatGPT, Connected, Disconnect. Do not expose MCP, OAuth client, grant, principal, tool IDs, `agent_connection_id`, or raw OAuth metadata except in a protected admin/debug context.

**Single app, role-based access.** One authenticated app at `app.reachmy.ai`. Do not create `user.reachmy.ai` or `admin.reachmy.ai`. Standard users get the Portal. Platform admin is `app.reachmy.ai/admin`, enforced by **backend authorization**, not frontend hiding.

**Near-term composition proof, beyond cross-provider identity:** two people can coordinate through ReachMy while each person’s AI privately uses that person’s own third-party connectors. ReachMy never needs those source-system integrations itself.

Canonical connector-composition example:

```text
Daniel asks for @jake’s availability
  → Daniel’s AI sends a ReachMy coordination request
  → Jake’s AI receives it
  → Jake’s AI privately uses Jake’s existing Google Calendar connector
  → Jake’s AI derives appropriate available windows
  → only those minimized results go through ReachMy
  → Daniel’s AI receives the available options
```

```text
User A → AI A + private connectors
       → minimized / derived result
       → ReachMy
       → AI B + private connectors
       → User B
```

ReachMy owns Agent Names, relationships, permissions, durable interactions, proposals/approvals, and authoritative network state. Private source systems stay with each user’s AI environment whenever possible.

---

## 2. Locked principles (still in force)

1. Identity belongs to the person (`Agent Name` / `@handle`), not the AI provider.
2. One Agent Name may have multiple authorized representatives (`agent_connections`).
3. The other party should not need to know which provider represents an Agent Name.
4. Existing AIs are the **daily** UX and daily control plane. The Portal is setup / connections / security / visibility only.
5. Users should not need to visit ReachMy regularly to operate the service.
6. Durable inbox compensates for providers that are not always-on. Pending work survives while the recipient is offline.
7. Permissions and owner escalation are first-class.
8. Interactions (not raw messages) are the primary product object.
9. Model prose is non-authoritative. Only structured tool/API state changes ReachMy records.
10. Use existing standards (MCP now). Do not replace them. A2A is a **future optional** routing/transport concept, not a near-term work item.
11. Prove cross-provider identity portability before expanding use cases — this is in progress as Phase 2.
12. No proprietary seed-phrase / crypto-wallet recovery. Standard account auth (Clerk).
13. Provider / display metadata is descriptive only and must never affect authorization.
14. `principal != agent_connection`. Agent Name != Claude/ChatGPT.
15. Users should never need to know MCP tool names, IDs, internal statuses, or implementation terminology. That is a product requirement, not polish.
16. ReachMy must not become a Google Calendar (or other source-system) integrator in order to prove coordination. Composition happens in the user’s AI.
17. Do not call `app.reachmy.ai` a daily SaaS dashboard. It must not grow inbox, messaging, proposal, scheduling, or chat UI.
18. One Portal app with roles. No separate user/admin hostnames. `/admin` is denied without a platform-admin role checked on the server.
19. Agent Name claiming is **AI-first**. The Portal may show “Not claimed yet” and later offer claim/edit as fallback; new users should not be forced to create `@name` in the Portal before Connect Claude / Connect ChatGPT.

---

## 3. Architecture

### 3.1 Daily network (unchanged)

```text
                         USER A
                           │
                           ▼
              AI A (Claude or ChatGPT)
              + that user’s private connectors
                           │
                     MCP + OAuth
                           ▼
              ┌────────────────────────────────────┐
              │ ReachMy (mcp.reachmy.ai)           │
              │ Agent Names · relationships        │
              │ permissions · durable inbox        │
              │ interactions · proposals/approvals │
              │ authoritative network state        │
              └──────────────────┬─────────────────┘
                                 │
                           MCP + OAuth
                           ▼
              AI B (Claude or ChatGPT)
                           │
                           ▼
                         USER B
```

### 3.2 Portal vs daily experience

**ReachMy Portal (`app.reachmy.ai`)**

- Account / setup
- Agent Name visibility
- AI connections
- Provider onboarding
- Security / recovery
- `/admin` for authorized platform admins
- Later, high-level activity visibility (separate future plan)

The Portal must not become the daily inbox, chat, coordination, proposal, or scheduling surface.

**ReachMy daily experience**

- Claude
- ChatGPT
- Other supported AI platforms later

Daily interactions, coordination, proposals, and approvals stay inside the user’s AI.

### 3.3 Public host split

```text
reachmy.ai          Framer marketing (unchanged)
app.reachmy.ai      Single authenticated app
                    ├─ ReachMy Portal (standard user)
                    └─ /admin (platform admin only; backend-enforced)
mcp.reachmy.ai      OAuth issuer, /mcp resource, domain APIs, consent
                    PUBLIC_URL=https://mcp.reachmy.ai  (do not change)
```

Do not add `user.reachmy.ai` or `admin.reachmy.ai`.

**Hard rules**

- Backend is the durable source of truth.
- AI clients are the daily control plane.
- Portal is not a SaaS dashboard and does not replace Claude/ChatGPT.
- Authorization: verified OAuth grant → account UUID `sub` → principal → scopes → relationship permissions → interaction/inbox/claim rules. Never email match. Never provider name.
- MCP OAuth **issuer and resource stay** `https://mcp.reachmy.ai` and `https://mcp.reachmy.ai/mcp`. Introducing `app.reachmy.ai` must not change them.
- Private source data must not become ReachMy state unless a minimized, purpose-bound result is required for the interaction.

**v1 topology (shipped):** one Railway process = REST + MCP + in-process OAuth AS + Clerk human auth + Neon. Canonical MCP host: `https://mcp.reachmy.ai`.

**Phase 3 topology (recommended, not implemented yet):** same Railway Node service, additional custom domain `app.reachmy.ai`, host-based routing. See §6 Phase 3 notes. Do not change `PUBLIC_URL`.

### 3.4 Desired journeys (Phase 3)

**New user**

```text
reachmy.ai
  → Get Started / Sign In
  → app.reachmy.ai
  → Clerk authentication
  → ReachMy account found or created
  → ReachMy Portal
  → Connect Claude or Connect ChatGPT
  → provider-specific installation (prefilled Claude link; guided ChatGPT alpha steps)
  → AI platform initiates ReachMy OAuth against mcp.reachmy.ai
  → that OAuth grant becomes a new agent_connection for the same principal
  → user returns to Claude/ChatGPT
  → conversational ReachMy onboarding/use continues there
      (AI-first: “Let's choose your Agent Name.” if none is claimed)
```

**Returning user**

```text
app.reachmy.ai
  → Clerk session
  → existing account + Agent Name
  → existing AI connections displayed as Connected / not connected
  → connect another AI, inspect status, or security/recovery
```

---

## 4. Current reality (do not re-litigate)

| Phase | Result |
|---|---|
| -1 | Claude MCP + OAuth + read/write + refresh. Report: `docs/phase-minus1-validation.md` |
| 0 | Invite → relationship → COORDINATE → TIME → approve → AGREED via API/scripts |
| 1 | Production MCP tools over Phase 0 domain. Real Claude validation passed |
| 2 | Cross-provider Claude↔ChatGPT on `mcp.reachmy.ai`. Production: `@jakebotberg` + `@margot_botberg`. Report: [`docs/phase2-validation.md`](phase2-validation.md) |

Phase 2 OAuth finding (already inspected, no architecture change): ChatGPT uses existing DCR, PKCE S256, resource `https://mcp.reachmy.ai/mcp`, unique redirect `https://chatgpt.com/connector/oauth/…`. Claude and ChatGPT are separate `agent_connections` for the same Agent Name. `provider` is unused for auth. Distinction is descriptive (OAuth `client_name` / redirect URI), not authorization.

Shipped browser surfaces on `mcp.reachmy.ai` today: `/sign-in` (Clerk JS), `/v1/auth/clerk`, `an_session` cookie (host-only), `/security` (lists connections including grant prefixes), `/invite/:token`, OAuth `/interaction`. These are bootstrap/fallback, not a product Portal.

---

## 5. Near-term workstreams

| Workstream | Near-term home | Intent |
|---|---|---|
| Cross-provider interoperability | Phase 2 | Same domain/auth for Claude and ChatGPT; either side may initiate, receive, propose, or approve |
| ReachMy Portal | Phase 3 | `app.reachmy.ai` setup, identity, connection visibility, security — not daily workflow |
| Provider installation / onboarding | Phase 3 | One ReachMy “connect AI” concept; Claude vs ChatGPT differ only at the install edge |
| Agent Name onboarding / terminology | Phase 3 | AI-first `@name` claim after Connect; Portal shows claimed / not claimed |
| Headless conversational UX | Phase 4 | Users never need tool names, IDs, internal statuses, or implementation terms |
| Cross-agent connector composition | Phase 5 | AI A + private tools → minimized result → ReachMy → AI B + private tools |
| Calendar handshake proof | Phase 5 | Canonical availability example using the user’s existing calendar connector |
| Privacy / data-minimization foundations | Phase 5–6 | Only derived, purpose-bound results transit ReachMy |
| Coordination refinement | Phase 6 | Tighten COORDINATE/TIME only as real composition/interop requires |

---

## 6. Phase sequence

Execute **one phase at a time**. Flag uncertainties instead of inventing platform capabilities.

### Completed

#### Phase -1 — MCP/OAuth spike

Claude as ReachMy interface: public HTTPS MCP, OAuth, stable account `sub`, read/write, refresh.

#### Phase 0 — Network core

API-first domain: invites, relationships, COORDINATE, inbox/claim, TIME proposal, approval → AGREED. Tiny web for auth/consent/security only.

#### Phase 1 — Production MCP (Claude control plane)

Thin MCP adapter over Phase 0 services. Agent Name language in tool copy. Real Claude validation.

### Near-term

#### Phase 2 — Cross-provider interoperability (Claude ↔ ChatGPT)

**Goal.** Prove ReachMy is provider-neutral with the same backend, OAuth/account model, Agent Names, permissions, durable inbox, interactions, proposals, and approvals.

**In scope**

- Finish paused Test A and Test B after this plan is approved
- Record Claude vs ChatGPT UX differences without normalizing tone
- Confirm no domain/authorization helper branches on provider name
- Confirm pending work survives while the recipient is offline

**Out of scope:** Resend, A2A, OpenClaw, Portal, new domain features, tone normalization, connector composition.

**Exit criteria**

- [x] Test A: cross-provider COORDINATE + durable inbox validated in production (`@jakebotberg` / `@margot_botberg`). TIME → approval → `AGREED` covered by automated MCP tests (see validation report).
- [x] Test B: accepted with Margot-on-Claude waived; Jake has both providers; reverse COORDINATE validated in production.
- [x] `@jakebotberg` remains one Agent Name with separate Claude and ChatGPT `agent_connections`.
- [x] Neither AI needs to know which provider represents the other Agent Name.
- [x] Claude-created and ChatGPT-created work use the same domain objects.
- [x] Proposals/approvals use shared domain services (automated proof).
- [x] Both providers use the existing domain services.
- [x] `docs/phase2-validation.md` written. Existing test suites still pass.
- [x] Phase 3 not started from this phase.

**Status:** Complete. See [`docs/phase2-validation.md`](phase2-validation.md).

**After Phase 2 closes:** detailed plan [`docs/plans/phase3-portal.md`](plans/phase3-portal.md) — **approved** (amended). Portal coding follows §19 slices in that document.

#### Phase 3 — ReachMy Portal + frictionless provider onboarding

**Goal.** Minimum `app.reachmy.ai` setup/control surface: authenticate, see Agent Name state, connect Claude and/or ChatGPT, disconnect with confirmation, then use ReachMy inside the AI. Not the daily product.

Approved direction (not a substitute for the detailed plan): [`docs/plans/phase3-portal-notes.md`](plans/phase3-portal-notes.md).

**In scope**

- Single app at `app.reachmy.ai` with role-based access; `/admin` reserved and backend-denied without platform-admin role
- Clerk authentication; find/create the ReachMy account
- Display Agent Name or **Not claimed yet** (do not require Portal claim before Connect)
- Your AI Connections: Connect Claude / Connect ChatGPT / Connected / Disconnect
- Claude: Anthropic prefilled custom-connector link; user confirms; OAuth at `mcp.reachmy.ai`
- ChatGPT: guide Developer Mode, custom MCP/app setup, per-conversation enablement; no fake automation
- Safe disconnect: explicit browser confirmation; reuse `revokeAgentConnection`; not account deletion
- Hand the user back to the selected AI; AI-first Agent Name claim (“Let's choose your Agent Name.”)
- Hide MCP/OAuth/grant/principal/tool IDs from standard users
- Safe session-authenticated connection list (not raw `GET /v1/connections`)

**Out of scope (forbidden on the Portal in Phase 3)**

- Inbox, messaging, interaction/proposal management, scheduling UI, ReachMy chat, daily workflow
- High-level activity/audit feed (future: `docs/plans/portal-visibility.md`)
- Large admin dashboard (only protect `/admin`; no user/account inspector yet)
- ChatGPT-specific domain/authorization logic
- Changing `PUBLIC_URL` / MCP issuer/resource
- Unique per-user MCP URLs
- `user.reachmy.ai` / `admin.reachmy.ai`
- Notification channels, OpenClaw, A2A

**Recommended topology (locked unless the detailed plan finds a strong reason not to)**

```text
Railway ReachMy Node/Hono service
  ├─ app.reachmy.ai   Portal / Clerk browser auth / /admin
  └─ mcp.reachmy.ai   MCP / OAuth / API   PUBLIC_URL unchanged
```

Same Railway service, same Neon, same domain services. Framer stays on `reachmy.ai`. No separate Next.js app unless Hono-served UI is proven insufficient.

**Exit criteria**

- [ ] Dedicated plan `docs/plans/phase3-portal.md` was approved before coding.
- [ ] Get Started / Sign In on `reachmy.ai` reaches `app.reachmy.ai` and Clerk.
- [ ] Signed-in user can Connect Claude and/or ChatGPT **before** claiming an Agent Name; Portal shows Not claimed yet when applicable.
- [ ] After OAuth, a new `agent_connection` exists on the same account/principal; user returns to that AI.
- [ ] Your AI Connections shows only user-facing labels (Claude/ChatGPT, Connected / not); no grant/client/token leakage.
- [ ] Disconnect uses a confirmation step and existing `revokeAgentConnection`; Agent Name remains.
- [ ] `/admin` is denied without a server-checked platform-admin role (including direct URL navigation).
- [ ] No inbox/messaging/proposal/scheduling/chat/activity-feed UI.
- [ ] MCP issuer/resource remain `https://mcp.reachmy.ai` and `https://mcp.reachmy.ai/mcp`.

#### Phase 4 — Headless conversational UX

**Goal.** After install, the user talks to their AI about people and plans. They should not need to know ReachMy tool names, record IDs, or internal statuses (`PENDING`, `AWAITING_OWNER`, `agent_connection_id`, etc.).

Dedicated deeper UX/tone work later: `docs/plans/conversational-ux.md`.

**Exit criteria**

- [ ] Invite → coordinate → propose → approve can be completed on Claude and ChatGPT using natural language only, with no user-visible instruction to call a named tool.
- [ ] Successful responses do not require the user to copy/paste UUIDs or status enums.
- [ ] Failures are explained in user language.
- [ ] Claude vs ChatGPT UX differences remain documented; tone is not prematurely normalized.
- [ ] Domain/authorization logic is unchanged except where copy/payload shaping requires it.

#### Phase 5 — Cross-agent connector composition and calendar handshake

**Goal.** Prove composition with the canonical availability example. ReachMy does **not** integrate Google Calendar.

Dedicated later plan: `docs/plans/connector-composition.md`.

**Exit criteria**

- [ ] Canonical availability flow completes with two humans; provider mix allowed; no provider-specific domain fork.
- [ ] Calendar data is not stored as ReachMy source-of-truth events. Only derived windows / proposal payload exist on ReachMy.
- [ ] Offline recipient still works via durable inbox.
- [ ] No ReachMy Google Calendar integration ships.
- [ ] Privacy rules for this flow are written.

#### Phase 6 — Privacy foundations and coordination refinement

Dedicated later plans: `docs/plans/security-privacy.md` plus coordination notes in this index only if still needed.

**Exit criteria**

- [ ] Written privacy/data-minimization rules for near-term interaction types, with tests.
- [ ] COORDINATE/TIME refinements limited to issues observed in Phases 2–5.
- [ ] No notification product. No always-on agent runtime. No A2A adapter.

### Later (dedicated plans, not this document)

See [`docs/plans/README.md`](plans/README.md). Do not expand this file when those workstreams start.

| Item | Future plan |
|---|---|
| Security & privacy guardrails | `docs/plans/security-privacy.md` |
| Conversational UX / response tone | `docs/plans/conversational-ux.md` |
| Third-party connector composition | `docs/plans/connector-composition.md` |
| Phase 3 Portal (detailed, after Phase 2) | `docs/plans/phase3-portal.md` |
| ReachMy Portal / agent activity visibility | `docs/plans/portal-visibility.md` |
| Notification strategy | `docs/plans/notifications.md` |
| A2A / future routing | `docs/plans/a2a-routing.md` |
| Wallet / financial-agent capabilities | `docs/plans/wallet-financial.md` |
| Advanced negotiation | `docs/plans/negotiation.md` |
| Business identities | `docs/plans/business-identities.md` |
| Resolve | `docs/plans/resolve.md` |
| Transact | `docs/plans/transact.md` |
| OpenClaw / always-on | Not scheduled |
| RLS | Still deferred |
| Daily SaaS dashboard | Forbidden |

---

## 7. What was removed or deferred from the original plan

Original source: Frozen V1 baseline, 2026-08-15.

| Original item | This revision |
|---|---|
| Phase 2 = second client **+ Resend / email** | Phase 2 is interoperability only. Email is deferred. |
| Phases 3–6 = UX polish → coordinate → negotiation → OpenClaw | Replaced by Portal + onboarding, headless UX, composition, calendar handshake, privacy |
| Website as tiny `/sign-in` `/security` on the MCP host only | Phase 3 adds `app.reachmy.ai` Portal; MCP host stays issuer/resource |
| “Get an MCP URL” as a product step | Forbidden. Shared `https://mcp.reachmy.ai/mcp` only |
| OpenClaw near-term | Removed |
| A2A as next standard to build | Future optional plan only |
| Resend / notification channels | Future `docs/plans/notifications.md` |
| Advanced negotiation, Business, Resolve, Transact | Future dedicated plans |
| Headless UX as polish | Phase 4 |
| Cross-agent connector composition | Phase 5 (new) |
| One giant implementation plan for all future work | This file is the index; major workstreams get their own plans |

**Unchanged:** principal ≠ agent; account UUID `sub`; grant-scoped `agent_connections`; provider metadata not for auth; AI is the daily control plane; COORDINATE/TIME/`AGREED`; transactional claims; no seed phrases.

---

## 8. Unresolved architectural and product questions

Do not invent answers during implementation. Resolve at the start of the relevant phase.

**Phase 2 / general**

1. **Offline without notifications.** Durable inbox only until a notification plan exists.
2. **Daniel’s setup.** Test A/B need `@daniel` on Claude and ChatGPT.
3. **Clerk Development vs Production.** **Resolved for Phase 3:** Clerk Production with root domain `reachmy.ai` before Portal production launch; subdomain session sharing for `app` + `mcp`; subdomain allowlist and `authorizedParties` limited to those hosts (not Framer apex). See [`docs/plans/phase3-portal.md`](plans/phase3-portal.md) §5.5, §7.
4. **Stale grants.** Older Railway-host Claude connection vs current `mcp.reachmy.ai` Claude connection.

**Phase 3 (resolved in [`docs/plans/phase3-portal.md`](plans/phase3-portal.md) unless noted)**

5. **SSO.** **Locked:** Clerk Production root-domain subdomain sharing + MCP Clerk bridge. Signed handoff ticket is **conditional fallback only** if production validation fails — not initial implementation.
6. **Descriptive AI labels.** **Locked:** infer at read time; do not persist provider field yet; never for authorization.
7. **ChatGPT install ceiling.** Still open — polish level before directory listing (non-blocking).
8. **Agent Name fallback in the Portal.** **Locked:** no Portal claim form in Phase 3; AI-first conversational claim required after Connect.
9. **Disconnect step-up.** **Locked:** explicit confirmation only; fresh Clerk re-auth deferred to `docs/plans/security-privacy.md`; revoke all active grants per provider.
10. **Platform-admin bootstrap.** **Locked:** `accounts.platform_role`; first admin via one-time manual SQL/script; `/admin` is 403 stub for non-admin.

**Later phases (unchanged)**

11. Composition protocol, calendar payload shape, prompt vs protocol, headless vs coarse tools, proposal authority after composition, A2A trigger — see previous revision; design in their dedicated plans.

---

## 9. Coding start policy

1. This document is the canonical roadmap/index. Review before any further implementation.
2. After this review: resume **Phase 2 Tests A/B only**. No Portal coding. No `PUBLIC_URL` change.
3. Phase 3 plan [`docs/plans/phase3-portal.md`](plans/phase3-portal.md) is approved (amended 2026-08-20). Implement per §19 slices; Clerk Production before production launch.
4. Provider-specific code remains allowed only at the install/OAuth edge. Shared domain services stay provider-blind.
5. When a later workstream starts, create its file under `docs/plans/` instead of growing this document.
6. Implementation naming: Portal routes/components/services (`portal*`), never `controlCenter*`.

---

## 10. Decision log (additions)

45. Product name in this plan is **ReachMy**. User-facing identity term is **Agent Name**.
46. Near-term AI platforms are **Claude and ChatGPT only**.
47. A2A is a future optional routing/transport concept.
48. Resend and all notification-channel decisions are deferred.
49. Advanced negotiation, Business identities, Resolve, and Transact are deferred to dedicated plans.
50. Headless conversational UX is a near-term phase, not polish.
51. Cross-agent connector composition is a major near-term capability.
52. Canonical composition proof is the calendar availability handshake.
53. Phase 2 no longer includes email.
54. Public hosts: `reachmy.ai` marketing, `app.reachmy.ai` Portal, `mcp.reachmy.ai` MCP/OAuth. One shared MCP URL.
55. Portal is setup/identity/connections/security/visibility. It is not a daily SaaS dashboard and must not host inbox/chat/workflow UI.
56. Phase 3 is **ReachMy Portal + frictionless provider onboarding**, after Phase 2 Tests A/B, and after a dedicated Phase 3 plan.
57. Recommended Phase 3 topology: same Railway service + `app.reachmy.ai` hostname; do not change the OAuth issuer.
58. Major future workstreams get separate plan documents under `docs/plans/`.
59. Single authenticated app at `app.reachmy.ai` with `/admin`; no `user.` / `admin.` hosts. Admin checks are backend-enforced.
60. Agent Name claiming is AI-first after Connect; Portal shows Not claimed yet rather than forcing Portal signup of `@name`.
61. SSO (Phase 3): Clerk Production subdomain session sharing + MCP Clerk bridge; signed handoff ticket is conditional fallback only if production validation fails.
62. Disconnect requires explicit browser confirmation and reuses `revokeAgentConnection`; not account deletion.
63. Current schema has no platform-admin role. Smallest addition: `accounts.platform_role` (`user` \| `admin`), default `user`. Not relationship permissions.
64. High-level Portal activity visibility is a future workstream, not Phase 3.
65. Product/docs/code term is **ReachMy Portal**, not Control Center. Future routes/components/services use `portal*`, not `controlCenter*`.

---

*End of canonical plan. Next implementation, after review: remaining Phase 2 Tests A/B only.*
