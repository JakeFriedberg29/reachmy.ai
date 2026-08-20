# Phase 3 Portal planning notes (approved direction)

**Status:** Direction captured 2026-08-19. **Not** the detailed implementation plan. Product term is **ReachMy Portal**, not Control Center.

Do **not** implement from this file. After Phase 2 Tests A/B close and `docs/phase2-validation.md` exists, write [`phase3-portal.md`](phase3-portal.md) and wait for approval before coding.

Canonical index: [`docs/implementation-plan.md`](../implementation-plan.md).

Future code (routes, components, services) should use Portal names (`portal`, `/admin` under the Portal app), not `controlCenter*`.

---

## Hosts (locked)

| Host | Role |
|---|---|
| `reachmy.ai` | Framer marketing |
| `app.reachmy.ai` | Single authenticated **ReachMy Portal** + `/admin` |
| `mcp.reachmy.ai` | MCP / OAuth / network backend |

`PUBLIC_URL=https://mcp.reachmy.ai` stays. One MCP URL: `https://mcp.reachmy.ai/mcp`. No unique per-user MCP URLs. No `user.reachmy.ai` or `admin.reachmy.ai`.

```text
Railway ReachMy Node/Hono service
  ├─ app.reachmy.ai
  │    ReachMy Portal / browser auth
  │    /admin  (backend-enforced platform admin)
  └─ mcp.reachmy.ai
       MCP / OAuth / API
```

Same Railway service, same Neon, same domain services. No separate Next.js app unless the detailed plan proves Hono-served UI is insufficient.

---

## Single app, two roles

```text
app.reachmy.ai   ReachMy Portal
├─ standard user
│  ├─ Agent Name (claimed or Not claimed yet)
│  ├─ Your AI Connections
│  ├─ Connect Claude / Connect ChatGPT
│  ├─ Connected / Disconnect
│  ├─ security / recovery / account setup
│  └─ later: high-level activity (not Phase 3)
└─ /admin
   └─ protected ReachMy platform-admin area
```

Navigating to `/admin` without the admin role must be **denied by the backend**, not merely hidden in the client.

Phase 3 does **not** build a large admin dashboard. Reserve and protect the route. Future admin (users, Agent Names, AI connections, OAuth troubleshooting, audit/support) is operational only; normal users never see another user’s private state. Detail later in `phase3-portal.md` and `portal-visibility.md`.

---

## Portal vs daily AI

**ReachMy Portal (`app.reachmy.ai`)** — account/setup, Agent Name visibility, AI connections, provider onboarding, security/recovery, `/admin` for authorized platform admins, later high-level activity visibility.

**Daily ReachMy experience** — Claude, ChatGPT, other supported AI platforms later.

The Portal must not become the daily inbox, chat, coordination, proposal, or scheduling surface.

Forbidden in Phase 3 UI: inbox, messaging, interaction/proposal management, scheduling, ReachMy chat, daily workflow, activity feed.

---

## Terminology

| User-facing | Meaning |
|---|---|
| Agent Name | Durable identity, e.g. `@jake` |
| AI Connection | Claude or ChatGPT authorized to represent that Agent Name |
| Connect Claude / Connect ChatGPT | Start provider install |
| Connected / Disconnect | Status / revoke |
| ReachMy Portal | `app.reachmy.ai` (not a product name “Control Center”) |

Hide from standard users: MCP, OAuth client, grant, principal, tool IDs, `agent_connection_id`, raw OAuth metadata (admin/debug only).

---

## Agent Name: AI-first

Preferred new-user path:

```text
app.reachmy.ai
  Agent Name: Not claimed yet
  Claude: [ Connect ]
  ChatGPT: [ Connect ]
```

After connect, the AI should prompt naturally: “Let's choose your Agent Name.”

The Portal may later offer claim/edit as fallback/account management. Do not require creating `@name` in the Portal before connecting an AI.

---

## Provider install (one concept, two edges)

**Claude.** Prefill custom-connector URL (name + `https://mcp.reachmy.ai/mcp`). User still confirms and completes ReachMy OAuth at `mcp.reachmy.ai`.

**ChatGPT (alpha/beta).** Guide Developer Mode, custom MCP/app setup, per-conversation enablement. Do not invent unsupported automation. Future directory/plugin can replace this path without identity/domain changes.

---

## Safe connection list

Do not expose current `GET /v1/connections` to the browser (includes `grant_id`, `oauth_client_id`).

Use a session-authenticated view such as: Claude Connected / ChatGPT Connected. Infer labels from OAuth `client_name` or redirect URI host. Descriptive only; never used for authorization.

---

## Disconnect

Security-sensitive. Polished UX:

```text
Claude    Connected    [ Disconnect ]
  → Disconnect Claude from @jake?
    Claude will immediately lose permission to act through ReachMy.
    [ Cancel ]  [ Disconnect ]
```

Explicit browser confirmation. Reuse `revokeAgentConnection`. Not ReachMy account deletion. Fresh Clerk re-auth is **unresolved** (Phase 3 / security plan).

---

## SSO (evaluate in detailed plan; do not implement now)

Goal: signed in at `app.reachmy.ai` → provider OAuth at `mcp.reachmy.ai` without unnecessarily re-entering Google/email.

Evaluate, in this order:

1. Short-lived signed one-time handoff / resume ticket
2. Clerk Production / satellite
3. Parent-domain session cookie **only if clearly justified**

Bias **away** from `Domain=.reachmy.ai` if a ticket is straightforward.

---

## Platform-admin schema

**Inspection:** `accounts`, `principals`, and `relationship_permissions` have **no** platform-admin role. Relationship permissions are pairwise Agent Name grants (messaging/scheduling), not staff access.

**Smallest clean addition (recommended, not implemented):** `accounts.platform_role` text, default `'user'`, allowed `'user' | 'admin'`. Enforce with `requirePlatformAdmin` on `/admin` and any `/v1/admin/*`. Do not rely on Clerk-only frontend flags. Do not use `relationship_permissions` for this.

Phase 3 may ship a 403 stub at `/admin` plus the column; do not build the operational dashboard yet.

---

## Future activity visibility (not Phase 3)

Example only, for `docs/plans/portal-visibility.md`:

```text
@jake
Your AI Connections
  Claude     Connected
  ChatGPT    Connected
Recent activity
  • Claude sent availability to @daniel
  • ChatGPT approved a proposal from @sarah
  • Claude used Calendar to answer a scheduling request
```

Human visibility/control, not the primary workflow. Do not implement in Phase 3 unless separately approved.
