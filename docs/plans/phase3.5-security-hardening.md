# Phase 3.5 — Security Hardening & Repository Hygiene

**Status:** Plan **approved** 2026-08-27. **Slices 1–5 complete** (including combined real-provider regression).
**Slice 6a:** OAuth observability deployed; ChatGPT `initial_authorization` captured (decision 100);
Claude `refresh` captured; Claude `initial_authorization` still outstanding. **Slice 6b remains
BLOCKED and is not complete** (decisions 96, 102, 103, 106–113). A local prototype demonstrated
centralized MCP scope enforcement; the proposed production mapping was **rejected**. Do not ship,
merge, or deploy 6b. Prototype parked at `prototype/phase3.5-slice6b-scope-enforcement`. **Slice 6a
diagnostic addendum** (MCP transport observability) deployed at `fdd09ee`. ChatGPT reconnect
grant-rebind remains in production (decision 105; still present after Slice 7
merge `5071c89`). **Slice 7 complete** (merged `5071c89`, Railway `20b54dd7`).
Slice 8 not started.
**Gate:** Phase 3 is **complete** and stays complete. Phase 4 has **not** started.
**Type:** Small stabilization phase. Not a feature phase. Not a refactor phase.

Canonical index: [`docs/implementation-plan.md`](../implementation-plan.md).
Phase 3 close-out: [`docs/phase3-validation.md`](../phase3-validation.md).
Phase 3 spec: [`docs/plans/phase3-portal.md`](phase3-portal.md).

---

## 1. Why this phase exists

A codebase review flagged issues appropriate to resolve before broader rollout. Phase 3.5 hardens
those areas **without destabilizing the working Phase 3 architecture**.

The governing constraint: ReachMy's value depends on Claude and ChatGPT connecting successfully.
Two of the findings (OAuth consent, Dynamic Client Registration) sit directly on that path. A
simplistic "security fix" to either one breaks both connectors. They are therefore treated as **one
design**, not two independent tickets.

### Core rule

Only make changes that materially improve **security**, **authorization correctness**, **deployment
safety**, **regression protection**, or **maintainability directly relevant to upcoming
development**. Anything else is out of scope even if the review mentioned it.

---

## 2. Findings re-verified against current code

Every finding below was re-read in the current tree before this plan was written. Line references
are current as of commit `6bdcfe6`.

| # | Finding | Verified? | Nuance discovered during re-anchor |
|---|---|---|---|
| 1 | MCP `/sign-in` open redirect | **Confirmed** | `src/server.ts:105,118`. Portal's `safeReturnPath` (`src/http/portal-host.ts:58`) is the right helper to reuse, but it also needs hardening — it does not reject `/\evil.com`, which some browsers normalize to a protocol-relative URL. |
| 2 | `COOKIE_KEYS` dev fallback | **Confirmed** | `src/config.ts:90`. Fallback is `phase-minus1-dev-cookie-key-change-me`. `isRailwayRuntime()` already exists in the same file as the production signal for the DB guard — reuse it rather than inventing a new one. |
| 3 | OAuth consent too broad | **Confirmed, and worse than described** | See §3. The logic is *inverted* relative to OAuth semantics, not merely permissive. |
| 4 | DCR is open | **Confirmed, but "gate it" is the wrong fix** | See §4. Both Claude **and** ChatGPT depend on DCR. Disabling it breaks the product. |
| 5 | Scope issuance too broad | **Confirmed, but the review's mechanism was wrong** | See §5. The OIDC scope *does* respect the request; the **resource** scope does not. |
| 6 | No CI / lint / format | **Confirmed** | No `.github/`, no ESLint, no Prettier. `tsconfig.json:15` excludes `tests/` from typecheck. |
| 7 | Duplicated HTTP test harness | **Confirmed** | `withServer` ×9, `sessionCookie` ×8, `seedOauthClient`/`seedAiConnection` ×5. |
| 8 | Stale docs / production identifiers | **Confirmed** | See §6. |

### New findings not in the original review

| # | Finding | Evidence |
|---|---|---|
| 9 | **Scope vocabulary does not cover all current tools.** `create_identity` and `revoke_agent_connection` / `request_disconnect_agent` are identity-*write* operations with no corresponding scope in `SCOPES`. | `src/auth/oidc.ts:8-9` vs `src/mcp/tools.ts:118,256` |
| 10 | **DCR clients never expire.** `upsert` is called without `expiresIn` for clients, so `expiresAt` is `null` and the row is permanent. Open DCR plus no retention means unbounded `oauth_models` growth. | `src/auth/drizzle-adapter.ts:8-11,17-18` |
| 11 | **The OAuth test helper already follows consent forms.** It regex-matches `action="…"` and re-POSTs. Adding a consent screen will therefore *not* break the six test files that call `obtainOAuthAccessToken`, provided the screen is a plain POST form. | `tests/helpers-oauth-token.ts:169-174` |
| 12 | **`phase-minus1-cli` static client and `/dev/callback` are live in production.** Low exploitability (the code renders on the victim's own screen, it is not exfiltrated) but unnecessary. | `src/auth/oidc.ts:113-122`, `src/server.ts:156-159` |

---

## 3. OAuth consent — what is actually wrong

`src/web.ts:194`:

```ts
if (details.prompt.name !== "login") {
  await completeOauthInteraction(provider, config, db, req, res, accountId);
  return true;
}
```

In `oidc-provider`, the two prompts mean different things:

- **`login`** — an *authentication* prompt. Raised when there is no provider session.
- **`consent`** — an *authorization* prompt. Raised when the grant is missing or does not cover the
  requested scopes.

The current code shows a UI for `login` and silently auto-completes `consent`. That is backwards:
the authorization prompt is the one that must be shown, and it is the one being skipped.

**Practical exposure.** Session TTL is 7 days (`src/auth/oidc.ts:135`). So:

| Scenario | Prompt raised | Today's behavior |
|---|---|---|
| First connector, fresh browser | `login` | Allow screen shown (accidentally acts as consent) |
| Second connector, same browser within 7 days | `consent` | **Auto-approved. No screen at all.** |
| Reconnect of an already-granted client | none | No screen (correct — grant already covers it) |

Combined with open DCR this forms a complete chain: an attacker registers a client via `/reg`,
crafts an `/auth` URL, and gets a user with an active provider session to visit it. The grant is
issued silently and the code is delivered to the attacker's redirect URI. PKCE does not help — the
attacker generated the challenge.

**This is the single most important fix in Phase 3.5.**

**UX impact is small and acceptable.** Because `oidc-provider` raises no prompt at all when an
existing grant already covers the request, adding a consent screen affects only genuinely new or
expanded authorizations. Refresh-token flows are unaffected. The observable change is one screen
when connecting a second AI — which is standard, expected behavior for Claude and ChatGPT users.

---

## 4. Dynamic Client Registration — keep it, and make consent the control

**Both providers depend on DCR. This is documented in our own validation reports.**

| Provider | Evidence |
|---|---|
| Claude | "Claude registers via DCR (`features.registration`). Each add-connector produces a new `client_id`." — [`docs/phase-minus1-validation.md:46`](../phase-minus1-validation.md) |
| ChatGPT | "Registration \| DCR (`POST /reg`); opaque `client_id`; CIMD not used" — [`docs/phase2-validation.md:113`](../phase2-validation.md) |

Disabling `/reg`, or requiring an initial access token, **breaks both connectors**. The review's
recommendation to gate registration is wrong for this product.

### Locked conceptual model

```text
client registration  →  establishes client identity + metadata   (open, validated, rate-limited)
human consent        →  authorizes that client for this user     (explicit, per client)

registration ≠ authorization
```

Registration alone must never produce access. That property is delivered by §3, not by restricting
`/reg`. Once consent is explicit, open DCR is safe — it is how every public MCP server operates.

### Controls to add while keeping DCR open

1. **Client metadata validation** — at least one `redirect_uri`; `https` required except
   `http://localhost` for native clients; no fragments or wildcards; cap the number of redirect URIs;
   cap `client_name` length. Determine first what `oidc-provider` already enforces natively and only
   add what is missing.
2. **Rate limiting on `/reg`** — per-IP. Single Railway process, so a small in-memory limiter is
   sufficient. No new infrastructure.
3. **Consent screen shows client identity** — `client_name` and redirect URI host, so the user can
   see who they are authorizing. Descriptive only; never used for authorization (locked principle 13).
4. **Retention for never-authorized clients** — finding #10. Registered clients that never obtained a
   grant should be prunable.
5. **Gate `phase-minus1-cli` and `/dev/callback` to non-production** — finding #12.

**Explicitly forbidden:** any provider-specific authorization authority. No allowlisting Claude or
ChatGPT redirect URIs, no branching on `client_name`. That would violate locked principles 13 and 3.

---

## 5. Scope semantics — correcting the review's mechanism

The review claimed grants always receive the full scope set regardless of request. That is **half
right**, and the distinction determines what we actually change.

`src/auth/oidc.ts:59-71`:

```ts
const paramScope = typeof details.params.scope === "string" ? details.params.scope.trim() : "";
grant.addOIDCScope(paramScope || SCOPES);        // ← respects the requested scope

for (const indicator of resources) {
  grant.addResourceScope(indicator, SCOPES);      // ← unconditionally full scope
}
```

The **OIDC** scope honors the request. The **resource** scope does not. Because the MCP access token
is audience-bound to `https://mcp.reachmy.ai/mcp`, the resource scope is what lands in the token.
Net effect matches the review's conclusion; the fix target is **line 70, not line 60**.

Independently corroborated by our own Phase 2 report: "Observed narrower initial scope; **grant still
receives full resource scopes**" ([`docs/phase2-validation.md:130`](../phase2-validation.md)).

### The compatibility risk this creates

That same line is the reason scope work is split into **observe** then **enforce**.

Phase 2 recorded that **ChatGPT requests a narrower initial scope than Claude**. Today the
over-grant papers over that difference. If we simultaneously (a) stop over-granting and (b) start
enforcing, ChatGPT tokens could lose scopes they currently rely on and tools would begin failing in
production.

We must therefore **measure what Claude and ChatGPT actually request** before changing issuance.
Slice 6a exists solely to gather that data.

### Minimal scope model

Current vocabulary (`src/auth/oidc.ts:8-9`) is nearly sufficient. Proposed mapping for tools that
exist **today** — no future taxonomy:

| Scope | Tools |
|---|---|
| `identity:read` | `get_my_identity`, `get_identity`, `resolve_identity`, `list_agent_connections` |
| `identity:write` **(new — finding #9)** | `create_identity`, `revoke_agent_connection`, `request_disconnect_agent` |
| `contacts:read` | `list_connections`, `get_relationship_permissions` |
| `contacts:write` | `create_invite`, `accept_invite`, `set_relationship_permissions` |
| `interactions:read` | `list_pending_interactions`, `get_interaction` |
| `interactions:write` | `create_interaction`, `respond_to_interaction` |
| `proposals:write` | `create_proposal` |
| `approvals:write` | `approve_proposal`, `reject_proposal` |
| `offline_access` | refresh tokens |

Scopes are an **additional** boundary. Account / principal / relationship / connection authorization
in `src/domain/` remains authoritative and unchanged.

---

## 6. Repository and documentation hygiene

| Item | Location | Action |
|---|---|---|
| Contradictory gate language | `docs/implementation-plan.md:5` says "documentation only… do not start Phase 3 coding" two lines above `:7` confirming Phase 3 complete | Rewrite header; add Phase 3.5 to §6 sequence |
| Phase 3 exit criteria unchecked | `docs/implementation-plan.md:320-328` all `[ ]` despite Phase 3 being closed | Check against `docs/phase3-validation.md` |
| Stale Phase 2 gate | `docs/phase2-validation.md:7` "Phase 3 not started" | Add a closing note; preserve the historical record |
| Stale plan index | `docs/plans/README.md` lists ~10 files that do not exist | Mark as planned-but-unwritten |
| Executed production script | `scripts/jake-clerk-production-cutover.sql` — real Clerk IDs, real handles, live `UPDATE`/`COMMIT`, marked already-run | Move to `scripts/archive/` with a warning header; sanitize identifiers |
| Reusable scripts with production identity data | `scripts/remap-clerk-production-ids.sql`, `scripts/inspect-production-identities.sql` | Replace real handles with placeholders |
| Personal email | `docs/phase3-validation.md:90` | Sanitize; keep the Clerk ID (not a credential, but reduce to a prefix) |

**Constraints:** do not rewrite git history. Prefer sanitizing and archiving over deleting. Preserve
useful operational knowledge — these scripts document how the Clerk cutover was performed.

**Target end state for phase status across all docs:**

```text
Phase -1  complete
Phase  0  complete
Phase  1  complete
Phase  2  complete
Phase  3  complete
Phase  3.5 current
Phase  4  not started
```

---

## 7. Slice plan

Ordered for independent implement → test → commit → validate. Security precedes tooling and
hygiene, per operator instruction.

| # | Slice | Risk | Depends on |
|---|---|---|---|
| 1 | Safe redirect helper | Low | — | **Complete** |
| 2 | Fail-closed production `COOKIE_KEYS` | Low–Medium | — | **Complete** |
| 3 | Shared HTTP test harness | Low | — | **Complete** |
| 4 | Explicit OAuth consent | **Medium–High** | 3 | **Complete (pending provider regression)** |
| 5 | DCR policy + metadata validation | Medium | 4 | **Complete (pending provider regression)** |
| 6a | Scope observability (report-only) | Low | 3 | **Deployed; ChatGPT observation captured; Claude `initial_authorization` still outstanding** |
| 6b | Scope issuance + enforcement | **High** | 6a, 4 | **Blocked — prototype only; mapping rejected (decisions 106–113)** |
| 7 | CI + lint + format + test discovery | Low–Medium | 3 |
| 8 | Docs + repository hygiene | Low | all |

### Note on slice 3 placement

Slice 3 is test infrastructure, and the operator asked for security before tooling. It is placed
third deliberately: **slices 4, 5, and 6 all require new HTTP-level OAuth tests**, and writing those
against nine duplicated harnesses would deepen the duplication this phase is meant to remove.
Slices 1 and 2 need only pure unit tests (no DB, no HTTP), so the two fastest security fixes still
land first. Slice 3 changes no application code.

**Operator approved this ordering 2026-08-27.** See decision 76.

---

### Slice 1 — Safe redirect helper

**Objective.** One shared, hardened redirect-path validator used by both Portal and MCP sign-in.
Eliminate the open redirect without creating competing validation logic.

**Approach.** Promote `safeReturnPath` from `src/http/portal-host.ts:58` into `src/http/host.ts`
(already pure, already unit-tested with no DB). Harden it, add a `fallback` parameter (Portal
defaults to `/`, MCP to `/security`), then call it from all three sites.

Rules: reject anything not starting with `/`; reject `//`; reject `/\`; reject control characters
and newlines (header-injection defense). Everything else passes through.

**Files.** `src/http/host.ts`, `src/http/portal-host.ts`, `src/server.ts` (`/sign-in`),
`src/web.ts` (`renderSignIn` — sanitize before embedding in `window.location.href`).

**Acceptance.**
- `/security`, `/some/local/path` → allowed
- `https://evil.com`, `//evil.com`, `/\evil.com`, `javascript:alert(1)` → fallback
- Portal redirect behavior unchanged
- Only one redirect validator exists in the codebase

**Tests.** Unit cases in `tests/host-routing.test.ts` (no DB — runs anywhere). One HTTP test
asserting `/sign-in?redirect=https://evil.com` never emits an off-host `Location`.

**Manual validation.** None.

---

### Slice 2 — Fail closed on production `COOKIE_KEYS`

**Objective.** Production must never boot with a default or weak cookie signing key. Preserve local
developer ergonomics.

**Pre-ship gate (required).** Before deploying Slice 2, **verify the existing Railway Production
`COOKIE_KEYS` value satisfies the proposed validation** (minimum length, not the dev default). If it
does not, update Railway variables first — otherwise the next deploy will fail to boot.

**Approach.** Add `assertSafeCookieKeys()` in `src/config.ts` beside the existing
`assertSafeDatabaseUrl()`, reusing `isRailwayRuntime()` as the production signal. Treat as
production when on Railway **or** when `PUBLIC_URL` is https with a non-localhost host.

- Production + missing / default / too-short → **throw at startup**
- Local / test → keep an explicit named dev fallback, emit a warning

**Files.** `src/config.ts`, `.env.example`, `README.md`.

**Acceptance.**
- Production + missing `COOKIE_KEYS` → startup error
- Production + the known dev default → startup error
- Production + short key → startup error
- Local without `COOKIE_KEYS` → boots with explicit warning
- All existing tests pass unchanged (they load `COOKIE_KEYS` from `.env`)

**Tests.** Extend `tests/db-safety.test.ts` (pure, no DB) with the production/local matrix.

**Manual validation.** **Required before deploy:** confirm the Railway `COOKIE_KEYS` value satisfies
the new minimum length (see pre-ship gate above), or the next deploy will fail to boot. Verify
first, then ship.

---

### Slice 3 — Shared HTTP test harness

**Objective.** Reduce duplicated test infrastructure and prevent future drift. Purely mechanical.

**Approach.** New `tests/helpers-http.ts` exporting `withServer`, `httpRequest`, `sessionCookie`,
`seedOauthClient`, `seedAiConnection`. Update the nine test files to import them. Leave
`scripts/portal-smoke.ts` alone — it is an operational script, not a test.

**Files.** New `tests/helpers-http.ts`; edits to `tests/phase3-slice{0,1,3,4,5,6,7,8}.test.ts` and
`tests/phase3-portal-signin-bridge.test.ts`.

**Acceptance.**
- No application code changed
- Test count unchanged (125 plus anything added by slices 1–2)
- Every test that passed before still passes
- No coverage reduction
- Local `withServer` / `httpRequest` / `sessionCookie` / seed definitions removed from slice files

**Tests.** The existing suite is the test. Pass count must match exactly.

**Manual validation.** None.

**Outcome (complete).** `tests/helpers-http.ts` exports `withServer`, `httpRequest`, `sessionCookie`,
`seedOauthClient`, `seedAiConnection`, plus the shared `HttpResult` / `HttpRequestOptions` types. Ten
test files now import them — the nine listed above plus `tests/sign-in-redirect.test.ts`, which Slice 1
added after this plan was written. Baseline and post-change suites both report **140 pass / 0 fail**.
No application code changed.

Two deliberate consolidations, both behavior-preserving:

- `withServer` always calls `setClerkBrowserSessionResolverForTests(null)` on teardown. Previously only
  the `phase3-slice3` copy did. `null` is the default state, so this is a no-op for the other files and
  removes a cross-test leak.
- `httpRequest` takes a single options object. `phase3-slice0` previously passed the method
  positionally; its two call sites now pass `{ method: "POST" }`. A `headers` escape hatch covers
  `sign-in-redirect`, which passed raw headers.

**Finding for Slice 7.** `tests/` is excluded from `tsconfig.json`, and an ad-hoc `tsc` run over the
suite surfaces one **pre-existing** error, unrelated to this slice: in `phase3-slice3.test.ts` the
inline cookie-jar helper tests `typeof setCookie === "string"`, but `IncomingHttpHeaders["set-cookie"]`
is `string[] | undefined`, so the branch narrows to `never`. Verified present at commit `4b2ea15`.
Slice 7 must fix it when it turns on test typechecking.

---

### Slice 4 — Explicit OAuth consent

**Objective.** A login session must not equal blanket authorization for any OAuth client. Show a
real consent screen for the `consent` prompt.

**Approach.** Invert the condition at `src/web.ts:194`. Render a consent page for the `consent`
prompt showing `client_name`, redirect URI host, and requested scopes, with a POST confirm. Keep the
`login` prompt as the authentication step. Do not prompt when `oidc-provider` raises no prompt —
that is the already-granted case and must stay silent.

Reuse the existing `htmlPage` shell in `src/web.ts`. Do **not** redesign the page (out of scope).

**Files.** `src/web.ts`; possibly a small prompt-summary helper in `src/auth/oidc.ts`.

**Acceptance.**
- New client + active session → consent screen shown, not auto-approved
- Consent screen displays client name, redirect host, requested scopes
- Confirming completes the flow and returns to the client
- Already-granted client re-authorizing → no screen (no regression)
- Refresh-token flow → no interaction
- `obtainOAuthAccessToken` still completes (finding #11 says it should, since it follows `action="…"`)

**Tests.** New `tests/oauth-consent.test.ts`: consent required for a new client; consent completes;
second authorization with an existing grant does not re-prompt; the six existing test files that use
`obtainOAuthAccessToken` still pass.

**Manual validation.** **Required.** Real Claude reconnect and real ChatGPT reconnect against a
deployed build. This is the highest UX-breakage risk in the phase.

**Outcome (code complete; provider regression outstanding).**

Root cause was the inverted condition at the old `src/web.ts:194`: `login` (authentication) rendered
a screen while `consent` (authorization) was auto-completed. Every prompt is now shown. The handler
no longer branches on prompt name at all, so no future prompt type can silently auto-approve.

New behavior by scenario:

| Scenario | Prompt | Before | After |
|---|---|---|---|
| First connector, fresh browser | `login` | Allow screen | Allow screen, now naming client + redirect host + scopes |
| Second connector, live session | `consent` | **Silently approved** | **Consent screen** |
| Reconnect of an already-granted client | none | No screen | No screen (unchanged) |
| Expired grant / widened scope, live session | `consent` | **Silently approved** | **Consent screen** |
| Refresh token | none | No interaction | No interaction (unchanged) |

Routes: `POST /interaction/:uid/login` became `POST /interaction/:uid/confirm`, and
`POST /interaction/:uid/deny` was added. Deny finishes the interaction with `access_denied` and is
handled before session resolution, since refusing needs no identity. The Allow form is emitted first
so the `action="…"` matchers in `helpers-oauth-token.ts`, `scripts/oauth-smoke.mjs`, and
`scripts/phase1-smoke.ts` keep selecting approval.

`summarizeConsent()` in `src/auth/oidc.ts` supplies `client_name`, redirect host, and requested
scopes for display. Descriptive only — no authorization decision reads it (locked principle 13).

One adjacent correctness fix: `completeOauthInteraction` re-asserts the login whenever the provider
session subject differs from the consenting account, not only when the session is absent. Previously
a stale provider session for another subject could receive the grant.

Verified non-vacuous: with the old auto-complete branch temporarily restored, the "existing session
does not silently authorize a different client" test fails; with the fix it passes.

**UX note for the deferred provider regression.** First-time connect is still a single screen,
because the `login` prompt submission carries both login and consent. The only added screen is the
second-connector case, exactly as §3 predicted.

---

### Slice 5 — DCR policy + client metadata validation

**Objective.** Keep DCR open for interoperability. Add the controls that make open registration safe
now that consent is explicit.

**Approach.** Per §4. First determine what `oidc-provider` validates natively, then add only the
gaps. Add a per-IP rate limiter on `/reg`. Gate `phase-minus1-cli` and `/dev/callback` to
non-production. Record the decision in this document's decision log.

**Files.** `src/auth/oidc.ts`; possibly new `src/auth/dcr-policy.ts`; `src/server.ts` (dev callback
gate).

**Acceptance.**
- Claude-shaped registration (`https://claude.ai/api/mcp/auth_callback`) succeeds
- ChatGPT-shaped registration (`https://chatgpt.com/connector/oauth/{id}`) succeeds
- `http://` non-localhost redirect URI rejected
- Excessive redirect URIs / oversized `client_name` rejected
- `/reg` rate limit returns a proper OAuth error, not a crash
- `/dev/callback` and `phase-minus1-cli` absent in production config
- No authorization logic branches on provider or `client_name`

**Tests.** DCR acceptance tests for both provider shapes; rejection tests for invalid metadata; rate
limit test.

**Manual validation.** **Required.** Add a fresh Claude connector and a fresh ChatGPT connector
end-to-end against a deployed build.

**Outcome (code complete; provider regression outstanding).**

DCR remains open and unauthenticated. Nothing was gated, and no rule reads provider, `client_name`,
or redirect hostname — the automated suite includes a registration by an unrecognized client name at
an unrecognized redirect host, which succeeds exactly like Claude's and ChatGPT's.

**What `oidc-provider@9.11.3` already enforces**, read from `lib/helpers/client_schema.js` rather
than assumed. It rejects fragments in redirect URIs (`:607`), requires at least one redirect URI when
response types are present (`:283`), rejects non-web schemes for `web` clients (`:612`), and rejects
`javascript:` / `data:` / `file:` and friends for `native` clients (`:640`). The https requirement at
`:617` applies **only to the implicit flow**. So for a code-flow `web` client — the exact shape both
providers register — plain `http:` is accepted on any hostname. That is the one real redirect gap,
and it was confirmed empirically: with the new validator disabled, the `http://claude.ai/...`
rejection test fails.

**Controls added** (`src/auth/dcr-policy.ts`, wired in `src/auth/oidc.ts`):

| Control (§4) | Delivered by |
|---|---|
| 1. Metadata validation | `validateClientMetadata`, reached through `extraClientMetadata` so static and dynamic clients pass through one code path |
| 2. Rate limiting on `/reg` | In-memory fixed-window per-IP limiter, 20 per 10 minutes, answering `429` + `temporarily_unavailable` + `Retry-After` before the request reaches the adapter |
| 3. Consent screen shows client identity | Already delivered by Slice 4 (`summarizeConsent`) — no new work |
| 4. Retention for never-authorized clients | `registered_at` stamped on Client rows at write time; `purgeUnauthorizedClients` retires only stamped, aged, grant-less rows |
| 5. Gate `phase-minus1-cli` and `/dev/callback` | `devStaticClients` returns `[]` in production; the `/dev/callback` route is not registered in production |

The validation rules are deliberately narrow: reject `http:` off loopback, reject wildcards, cap
redirect-URI count (10), `client_name` length (120), and redirect-URI length (2048). Everything else
is left to the provider's native schema. In particular **custom schemes such as `myapp://callback`
are still accepted for native clients**, because neither provider uses them and rejecting them would
tighten interoperability on a guess (decision 88).

Loopback `http:` stays registrable. It is the RFC 8252 native-app pattern, it is not remotely
reachable, and the Phase -1 CLI client depends on it locally.

**Retention is conservative by construction.** A Client row is retired only when it carries a
`registered_at` stamp, is older than the caller's cutoff, **and** no `Grant` row references it. Rows
written before stamping existed are never retired, so no client already live in production can be
removed. No scheduler was added; the function is called deliberately.

**Tests.** `tests/dcr-policy.test.ts` (9, pure — no DB or HTTP) and `tests/dcr-registration.test.ts`
(13, HTTP over `tests/helpers-http.ts` per decision 81). Suite moves from **149 to 171 pass**.
Verified non-vacuous: with `validateClientMetadata` neutralized, exactly the three metadata-rejection
tests fail and every interoperability test still passes.

---

### Slice 6a — Scope observability (report-only)

**Objective.** Learn what Claude and ChatGPT actually request before changing issuance. **No
behavior change.**

**Approach.** Expose the `scope` claim from `verify-token.ts`. Log requested vs. granted scopes at
authorization time. Add the tool→scope map from §5 and evaluate it per MCP call in **report-only**
mode: log what *would* be denied, deny nothing.

**Files.** `src/auth/oidc.ts` (logging), `src/auth/verify-token.ts` (expose scopes), new scope map
module, `src/mcp/tools.ts` (report-only check).

**Acceptance.**
- No request is denied that previously succeeded
- Logs show requested scopes, granted scopes, and would-be denials per tool call
- Scope map covers every tool in `executeTool`, including `create_identity` and
  `revoke_agent_connection` (finding #9)

**Tests.** Unit tests for the scope map (every tool has an entry). `verify-token` exposes scopes.

**Manual validation.** **Required.** Deploy, exercise Claude and ChatGPT, then collect logs. **Slice
6b must not begin until this data exists and is documented** (requested scopes per provider, any
would-be denials). Do not narrow scope issuance until real authorization requests have been
observed.

**Outcome (code complete; real-provider scope observations outstanding).**

Structured scope observations are emitted through the existing `logOauth` / `oauth_debug` JSON log
stream — no new observability system. Three report-only events:

| Event | When | Fields (no secrets) |
|---|---|---|
| `scope_authorization_observed` | OAuth consent completion (`completeOauthInteraction`) | `client_id`, descriptive `client_name` / `redirect_host`, `flow_kind` (`initial_authorization` \| `reauthorization`), `prompt_name`, `grant_id`, `requested_scopes`, `granted_oidc_scopes`, `granted_resource_scopes`, `scope_expanded` |
| `scope_token_observed` | Access token issued (`authorization_code` or `refresh`) | `flow_kind`, `client_id`, `grant_id`, `token_scopes` |
| `scope_mcp_would_deny` | MCP tool call where token scopes would not satisfy the proposed tool→scope map | `tool`, `required_scope`, `granted_scopes`, `client_id`, `grant_id` |

Implementation: `src/auth/scope-map.ts` (proposed tool→scope map), `src/auth/scope-observability.ts`
(build/log helpers), logging wired in `src/auth/oidc.ts`, scopes exposed on `VerifiedPrincipal` in
`src/auth/verify-token.ts`, report-only check at the top of `executeTool` in `src/mcp/tools.ts`.
MCP `authInfo.scopes` now reflects token scopes rather than a hardcoded placeholder.

**Current issuance behavior (unchanged — observation only):** OIDC scopes honor the client
request (`grant.addOIDCScope(paramScope || SCOPES)`). Resource scopes for the MCP audience are
**always expanded to the full `SCOPES` set** (`grant.addResourceScope(indicator, SCOPES)`). The
`scope_defaulted` middleware still applies the full scope set when a client omits `scope`.

**Current MCP enforcement behavior (unchanged — observation only):** Valid bearer tokens are
accepted; domain authorization remains authoritative. The tool→scope map is evaluated in
report-only mode only — `scope_mcp_would_deny` logs what *would* be blocked in Slice 6b but denies
nothing.

**Tests.** `tests/scope-observability.test.ts` (10). Suite moves from **171 to 181 pass**.

#### Real-provider scope observations (captured 2026-08-28 from deployed `oauth_debug` logs)

These are the first structured, provider-attributed scope records. They supersede the historical
leads in decision 95.

**ChatGPT — `scope_authorization_observed`, `flow_kind: initial_authorization`, `prompt_name: consent`,
`client_name: ChatGPT`, `redirect_host: chatgpt.com`:**

| Field | Value |
|---|---|
| `requested_scopes` | `openid`, `identity:read`, `interactions:write` |
| `granted_oidc_scopes` | `openid`, `identity:read`, `interactions:write` (identical to requested) |
| `granted_resource_scopes` | expanded to the full supported set |
| `scope_expanded` | `true` |
| resulting `scope_token_observed` | `openid`, `identity:read`, `interactions:write` |

**Claude — `scope_token_observed`, `flow_kind: refresh`:** `identity:read`, `interactions:write`,
`offline_access`.

**Two conclusions follow, and both change Slice 6b.**

First, **the access token carries the client's requested scopes, not the expanded resource scopes.**
ChatGPT's grant was expanded to the full set (`scope_expanded: true`) yet its token contained exactly
the three scopes it asked for. This contradicts §5's stated mechanism ("the resource scope is what
lands in the token"). The over-grant is real at the grant level but is **not** what reaches the MCP
boundary, so narrowing issuance is a smaller change than §5 assumed — and enforcement is a much
larger one.

Second, **the proposed tool→scope map would break real Claude traffic today.** A live
`scope_mcp_would_deny` was emitted for `list_connections`, which the map requires `contacts:read` for,
against a Claude token that does not carry `contacts:read`. Under Slice 6b as currently drafted that
call would have failed in production. The map must be revised — or issuance widened to match it —
before enforcement is switched on. This is exactly the compatibility risk §5 predicted, now measured
rather than inferred.

**Gate 96 status: partially satisfied.** The ChatGPT half is complete — a fresh
`initial_authorization` with requested, granted, and token scopes recorded. The Claude half is not:
we have only a `refresh` observation, not a `scope_authorization_observed` from a fresh Claude
authorization. Obtaining it requires a new Claude authorization, which the operator has explicitly
deferred; the Claude grant is not to be revoked.

---

### Slice 6a diagnostic addendum — MCP transport observability (report-only)

**Why this was added.** Collecting the Slice 6a scope observations requires driving real tool calls
from Claude and ChatGPT. ChatGPT instead sits indefinitely on "Working" for a request as simple as
"What is my ReachMy identity?", and the deployed logs could not say why. Railway Network Logs for
2026-08-28 ~13:50 show `POST /mcp → 200` three times, but Deploy Logs in the same window contain only
`scope_token_observed` for the Claude `client_id` / `grant_id` on a `refresh` flow. Network Logs carry
no client identity, so those 200s are most plausibly Claude, and **no ChatGPT-attributable `/mcp`
traffic has ever been proven**.

**The gap that made this unanswerable.** `logOauth("http_done")` covers only `/auth`, `/interaction`,
`/reg`, and `/token`. A *successful* `/mcp` request emitted nothing at all, and an HTTP 200 on `/mcp`
is not evidence of a completed exchange: Claude and ChatGPT are both legacy clients, so
`createMcpHandler` routes them through the stateless legacy fallback, which answers `200` with
`text/event-stream` headers **before** the tool runs. The automated trace test confirms this ordering
directly — `mcp_response_started` is emitted between `mcp_tool_call_started` and
`mcp_tool_call_completed`. A hang after the headers is therefore indistinguishable from success in
Network Logs.

**Events.** Emitted on a separate `mcp_debug` message so they are searchable independently of
`oauth_debug`. Every event on one request shares a `request_id`.

| Event | When | Fields (no secrets) |
|---|---|---|
| `mcp_request_received` | Entry to `/mcp`, before auth | `http_method`, `accept`, `content_type`, `mcp_protocol_version`, `has_mcp_session_id`, `has_authorization`, `user_agent` |
| `mcp_token_verified` | After bearer verification | `ok`, `client_id`, `grant_id`, `has_connection`, `onboarding`, `token_scopes` |
| `mcp_method_received` | Authenticated request, body parsed | `rpc_method`, `tool_name`, `rpc_id`, `batch_size`, `is_notification` |
| `mcp_tool_call_started` | Entry to `executeTool` | `tool`, `arg_keys` (key names only), `client_id`, `grant_id` |
| `mcp_tool_call_completed` | `executeTool` returned | `tool`, `is_error`, `error_code`, `ms` |
| `mcp_response_started` | SDK handler returned a `Response` | `status`, `content_type`, `streamed` |
| `mcp_response_completed` | Response body settled | `completed`, `bytes`, `reason` (`client_cancelled` / `stream_error` / `invalid_token`) |
| `mcp_http_done` | Node socket `end()` for any `/mcp` path | `method`, `path`, `status`, `ms` — no `request_id`; it is the ground-truth socket close |

**Interpretation matrix for the ChatGPT hang.**

| Observed | Meaning |
|---|---|
| No `mcp_debug` for the attempt | ChatGPT never reached ReachMy |
| `mcp_token_verified` `ok:false` only | 401 path; no tool ran |
| Reaches `mcp_method_received`, no `mcp_tool_call_started` | Transport/protocol rejected before dispatch |
| `mcp_tool_call_started` with no `..._completed` | Hang inside `executeTool` / domain code |
| `mcp_tool_call_completed` but `mcp_response_completed` `completed:false` | ReachMy answered; the SSE stream did not finish |
| Full chain, `completed:true`, `mcp_http_done` present | ReachMy finished; the hang is client-side |

**Report-only, by construction.** `logMcp` swallows its own errors, no logged value is read by any
authorization, transport, or protocol decision, and `traceResponseBody` re-emits the original status,
status text, headers, and bytes. Sensitive keys are dropped by an allowlist-inverse regex; only
`client_id`, `grant_id`, and `request_id` correlate. Tool **argument values** are never logged — key
names only. `user_agent` is descriptive only (locked principle 13).

**Files.** New `src/mcp/observability.ts`; `/mcp` route and the socket-close hook in `src/server.ts`;
`executeTool` wrapper in `src/mcp/tools.ts` (dispatch body moved unchanged into `dispatchTool`);
`requestId` threaded through `src/mcp/server.ts`.

**Tests.** New `tests/mcp-http-transport.test.ts` (7) — the first tests that exercise a real
`POST /mcp` over Streamable HTTP rather than calling `executeTool` directly. Covers the 401 challenge,
`initialize`, `tools/list` against `ALL_MCP_TOOLS`, a `tools/call` whose SSE body arrives complete,
`202` for notifications, `406` for a client that will not accept `text/event-stream`, and the full
single-`request_id` trace including a no-secrets assertion. Suite moves from **181 to 188 pass**.

Verified non-vacuous by construction: the trace test was first written asserting
`mcp_response_started` *after* tool completion and failed, which is how the pre-tool SSE header
ordering above was established.

**One latent test defect fixed.** `scope observability: verify-token exposes scopes from JWT access
token` built a verifier for `PUBLIC_URL` while serving on an ephemeral port, so it passed only when a
separate `pnpm dev` happened to occupy port 3000 and failed (after a ~110s JWKS retry stall) otherwise.
It now uses `withServerOnPublicUrlPort`, the helper added for the transport tests, which also waits for
the shared port instead of failing when concurrent test files contend for it.

**Deployment status.** Deployed at `fdd09ee` (2026-08-28). Slice 6a OAuth observability and this
MCP transport addendum are both live. The ChatGPT "Working" hang is still open; diagnosis now uses
`mcp_debug`, not further OAuth troubleshooting (decision 104).

---

### Slice 6b — Scope issuance + enforcement

**Blocked. Not complete. Do not ship.** A 2026-08-30 prototype demonstrated centralized MCP tool
boundary enforcement (fail closed, `insufficient_scope`, denial before domain execution). The
proposed production mapping is **rejected** (decision 106).

Real Claude/ChatGPT tokens currently expose only the practical resource capabilities `identity:read`
and `interactions:write` (plus protocol `openid` / `offline_access`). Mapping broad write authority
onto `identity:read` would make Slice 4 consent misleading and is not acceptable. Treating
`interactions:write` as an end-to-end coordination bundle is more defensible, but it still does not
match the advertised fine-grained taxonomy (`contacts:*`, `interactions:read`, `proposals:write`,
`approvals:write`). Fine-grained enforcement cannot safely ship until real clients can genuinely
request and obtain those scopes. Silently expanding requested scopes remains forbidden.

`offline_access` and `openid` remain protocol scopes and never authorize MCP tools.

**Still blocked on:**
- a coherent final scope model (honest fine-grained issuance, or honestly named coarse bundles)
- working ChatGPT live validation (connector/auth is not a reliable 6b regression client)
- fresh Claude `scope_authorization_observed` `initial_authorization` evidence (gate 96 / decision 103)

Prototype (not for production): local branch `prototype/phase3.5-slice6b-scope-enforcement`. Do not
merge or push it to `main` unless explicitly requested.

**Objective (unchanged, unmet).** Stop over-granting resource scopes. Enforce a semantically honest
scope model at the MCP boundary.

**Acceptance (unchanged, unmet).** Token/grant scopes match what was requested; tools fail closed
without the required scope; domain authorization remains authoritative; Claude and ChatGPT still
complete a full lifecycle. Plus: consent-screen scope names must match actual authority.

**Manual validation.** Still required before any future 6b ship: live Claude and ChatGPT regression.
Do not use the current connections to force Claude re-authorization.

---

### Slice 7 — CI, lint, format, test discovery

**Objective.** Lightweight automated engineering gates. No complicated build or release system.

**Approach.** ESLint (typescript-eslint) + Prettier with incremental format checks: `pnpm
format:check` runs Prettier only on files changed vs `origin/main` (plus untracked), so historical
trees are not rewritten and newly touched application/test files become covered. Replace the
hand-enumerated `test` script with glob-based discovery. Typecheck `tests/` (currently excluded by
`tsconfig.json:15`).

**CI constraint (real).** The suite requires a live Neon dev database and Clerk keys. CI must
therefore run in two tiers. Integration `DATABASE_URL` comes only from GitHub secret
`DATABASE_URL_DEV` (Neon development branch). The existing `assertSafeDatabaseUrl` guard refuses the
production Neon endpoint in GitHub Actions even if `RAILWAY_*` or `ALLOW_PRODUCTION_DB` leak in.
Do not copy Railway production variables into GitHub Actions.

- **Always:** typecheck, lint, format check, and the DB-free unit tests (`host-routing`,
  `db-safety`, scope map, redirect helper)
- **With secrets:** full `pnpm test` and `pnpm smoke:portal`

**Files.** `.github/workflows/ci.yml`, `eslint.config.js`, `.prettierrc`, `package.json`, tsconfig
additions.

**Acceptance.**
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` all pass locally
- Adding a new `tests/*.test.ts` file runs automatically with no `package.json` edit
- CI green on a pull request
- No large formatting diff across unrelated historical files

**Tests.** CI itself is the test.

**Manual validation.** None.

**Status.** Complete 2026-08-30. Merged to `main` as `5071c89` (PR #1). GitHub Actions
on `main` (`33346182862`) passed both tiers: no-secret unit job and integration
(`pnpm test` 198, `pnpm smoke:portal`). Railway production deploy `20b54dd7` is
that SHA. Grant-rebind from `cf7b84a` remains. Slice 6b prototype and the
diagnostic rollback branch were not merged.

---

### Slice 8 — Documentation and repository hygiene

**Objective.** Active repo artifacts accurately reflect reality; production-specific identity data
removed from reusable scripts.

**Approach.** Per §6. Then write `docs/phase3.5-validation.md`.

**Files.** `docs/implementation-plan.md`, `docs/phase2-validation.md`, `docs/phase3-validation.md`,
`docs/plans/README.md`, `scripts/*.sql` → `scripts/archive/`, new `docs/phase3.5-validation.md`.

**Acceptance.**
- No document contradicts another about phase status
- Phase 3 exit criteria checked and cited
- Phase 3.5 present in the canonical sequence; Phase 4 marked not started
- Executed cutover script archived with a warning header
- Reusable scripts contain placeholders, not real handles
- No git history rewritten
- Historical validation records preserved

**Tests.** None (documentation).

**Manual validation.** Operator review.

---

## 8. Exit gate

Phase 3.5 is complete only when all of the following hold:

- [ ] Open redirect fixed and covered by automated tests
- [ ] Production cookie signing configuration fails closed
- [ ] OAuth consent behavior is explicit and safe
- [ ] DCR behavior explicitly understood, documented, and safely supported
- [ ] OAuth scopes correctly issued and enforced
- [x] CI / lint / format / test gates exist and pass
- [ ] Duplicated HTTP test infrastructure meaningfully reduced
- [ ] Active docs and repo artifacts cleaned up
- [ ] Phase 3 functionality intact
- [ ] **Claude and ChatGPT still connect and operate through ReachMy**

Final validation run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke:portal
```

Plus real-provider regression on Claude and ChatGPT (required by slices 4, 5, and 6b).

---

## 9. Explicitly out of scope

Not in Phase 3.5 under any circumstances:

Portal rewrite · migrating Portal routing into Hono · auth-resolver architecture rewrite · splitting
`portal-ui.ts` because it is large · CSS / static asset redesign · N+1 query optimization ·
pagination · database performance work · deleting unused or future schema tables ·
`agent_connections.provider` redesign · cross-agent connector composition · conversational UX /
Phase 4 · A2A · OpenClaw · notifications · wallets / payments · business identities · advanced
negotiation · Resolve · Transact · Framer.

Deleting `src/auth/memory-adapter.ts` is *permitted but not required* — it is unreachable dead code,
not a security issue. Do not spend slice time on it.

---

## 10. Decision log

| # | Decision |
|---|---|
| 66 | Phase 3.5 is a stabilization phase between Phase 3 and Phase 4. Phase 3 remains closed. |
| 67 | OAuth consent and DCR are **one** security design, not independent fixes. |
| 68 | **DCR stays open.** Claude and ChatGPT both depend on it (`phase-minus1-validation.md:46`, `phase2-validation.md:113`). Disabling it would break the product. |
| 69 | Registration establishes client identity. Consent authorizes that client for a user. Registration alone is never authorization. |
| 70 | No provider-specific authorization authority. Client metadata stays descriptive (locked principle 13). |
| 71 | Scope work splits into observe (6a) then enforce (6b). Issuance must not be narrowed before real Claude/ChatGPT scope requests are measured. |
| 72 | Scopes are an additional boundary. Domain authorization remains authoritative. |
| 73 | One redirect validator for the whole codebase, living in `src/http/host.ts`. |
| 74 | Production cookie key validation reuses `isRailwayRuntime()`, matching the existing DB guard. |
| 75 | No git history rewriting. Sanitize and archive rather than delete. |
| 76 | Slice 3 (shared HTTP test harness) runs third, before the OAuth slices, so slices 4–6 are not written against nine duplicated harnesses. Slices 1 and 2 still land first — their tests need neither a database nor the HTTP harness. |
| 77 | Slice 1 complete: `safeReturnPath` lives in `src/http/host.ts`; Portal fallback `/`, MCP fallback `/security`. |
| 78 | **Slice 2 pre-ship gate:** verify Railway Production `COOKIE_KEYS` meets validation before deploying fail-closed config. |
| 79 | **Scope slices gate:** do not narrow OAuth scope issuance (Slice 6b) until Slice 6a logs document real Claude and ChatGPT authorization requests. |
| 80 | Slice 2 complete: `assertSafeCookieKeys` fails closed in production; local dev keeps named fallback with one-time warning. |
| 81 | Slice 3 complete: `tests/helpers-http.ts` is the single HTTP test harness. New HTTP-level tests in slices 4–6 import it rather than defining local copies. |
| 82 | Slice numbering is **as written in §7**. Explicit OAuth consent is **Slice 4**, not Slice 3. Ordering re-confirmed by the operator 2026-08-27 when the question was raised again. |
| 83 | Slice 4 code complete: no interaction prompt is ever auto-completed. The consent handler does not branch on prompt name, so a new prompt type cannot silently approve. |
| 84 | Consent is a two-outcome decision. Deny is a first-class route returning `access_denied`; it is not a dead-end page. |
| 85 | A grant is only ever issued to the account that consented. `completeOauthInteraction` re-asserts login on any provider-session subject mismatch. |
| 86 | **Slice 5 gate:** Slice 4's real Claude and ChatGPT reconnect regression must be run against a deployed build before Slice 5 ships, since Slice 5 also touches the connect path. |
| 87 | Slice 5 code complete. DCR stays open and unauthenticated; safety comes from consent (Slice 4) plus transport, size, volume, and retention controls on registration. |
| 88 | Redirect URI policy is exactly "no `http:` off loopback", plus no wildcards and size caps. Custom schemes remain allowed for native clients — `oidc-provider` already rejects the dangerous ones, and forbidding the rest would narrow interoperability on a guess about clients we have not observed. |
| 89 | Client metadata policy runs through `oidc-provider`'s `extraClientMetadata` hook, so statically configured and dynamically registered clients are judged by the same code. |
| 90 | DCR clients are stamped with `registered_at` when written. `purgeUnauthorizedClients` retires only rows that are stamped, past the cutoff, and referenced by no grant — so authorized clients and pre-stamping production rows are never removed. |
| 91 | **Supersedes 86 in effect:** Slices 4 and 5 both change the connect path and are validated together in one real Claude and ChatGPT regression against a deployed build. Slice 5 is committed but not deployed until that run passes. **Update 2026-08-28:** combined real-provider regression passed — fresh Claude and ChatGPT connector registration/authorization, consent screen, existing `@jakebotberg` identity and connections intact, DCR still works with both providers. |
| 92 | **Current scope issuance (pre-6b):** OIDC scopes honor the client request; MCP resource scopes are unconditionally expanded to the full supported set in `applyRequestedGrant`. Clients that omit `scope` receive the full set via `scope_defaulted` middleware. |
| 93 | **Current MCP scope enforcement (pre-6b):** None at the OAuth-scope boundary. Any valid MCP bearer token passes; `src/domain/` authorization remains authoritative. |
| 94 | **Slice 6a observability:** Report-only structured logs via existing `oauth_debug` stream — `scope_authorization_observed`, `scope_token_observed`, `scope_mcp_would_deny`. Proposed tool→scope map in `src/auth/scope-map.ts` includes `identity:write` for `create_identity` / disconnect tools (finding #9). No secrets logged; `client_id` and `grant_id` are allowed correlation identifiers. |
| 95 | **Real-provider scope evidence collected so far (historical, not from 6a logs):** Phase 2 observed ChatGPT requests a narrower initial scope than Claude while grants still receive full resource scopes ([`docs/phase2-validation.md:130`](../phase2-validation.md)). Claude often includes `offline_access`; ChatGPT observed narrower. Consent screens from Slices 4–5 regression show requested scopes to the user but do not record provider-specific issuance in structured logs. Treat as leads only. |
| 96 | **Slice 6b gate (unchanged):** Blocked until deployed Slice 6a captures structured `scope_authorization_observed` entries for at least one fresh Claude authorization and one fresh ChatGPT authorization, documenting requested scopes, granted scopes, `scope_expanded`, and any `scope_mcp_would_deny` patterns during normal tool use. |
| 97 | **HTTP 200 on `/mcp` is not evidence of a completed exchange.** Legacy clients (Claude and ChatGPT) take the stateless legacy fallback, which returns `200` with `text/event-stream` headers before the tool runs — confirmed by the emitted event order in `tests/mcp-http-transport.test.ts`. Completion is proven by `mcp_response_completed` `completed:true` plus `mcp_http_done`, not by the status line in Railway Network Logs. |
| 98 | **Slice 6a diagnostic addendum:** report-only MCP transport tracing on a separate `mcp_debug` stream (`mcp_request_received`, `mcp_token_verified`, `mcp_method_received`, `mcp_tool_call_started`, `mcp_tool_call_completed`, `mcp_response_started`, `mcp_response_completed`, `mcp_http_done`), correlated by `request_id`. Added to localize the ChatGPT "Working" hang, which also blocks collecting the Slice 6a provider scope observations. No authorization, transport, or protocol decision reads it; tool argument **values** are never logged. |
| 99 | **Diagnostics do not authorize anything and must not be able to break a request.** `logMcp` swallows its own failures and `traceResponseBody` re-emits status, headers, and bytes unchanged. Any future observability follows the same rule. |
| 100 | **ChatGPT scope observation captured (2026-08-28), satisfying the ChatGPT half of gate 96.** Fresh `initial_authorization` on the `consent` prompt from `client_name: ChatGPT` / `redirect_host: chatgpt.com` requested and was granted exactly `openid`, `identity:read`, `interactions:write`; resource scopes were expanded (`scope_expanded: true`); the issued token carried only those three scopes. |
| 101 | **Token scopes track the client's *requested* scopes, not the expanded resource scopes — correcting §5.** ChatGPT's grant was expanded to the full supported set yet its token contained only its three requested scopes, and Claude's refresh token carried only `identity:read`, `interactions:write`, `offline_access`. The grant-level over-grant is real but does not reach the MCP boundary. Slice 6b's issuance change is therefore smaller than §5 assumed, and its enforcement change is larger. |
| 102 | **The proposed tool→scope map would break real Claude traffic and must not be enforced as drafted.** A production `scope_mcp_would_deny` fired for `list_connections` (map requires `contacts:read`) against a live Claude token without `contacts:read`. Slice 6b must first reconcile the map with observed real tokens — by revising required scopes, widening what clients are asked to request, or both — and must not flip enforcement on the current mapping. |
| 103 | **Gate 96 is only half met.** ChatGPT: complete. Claude: outstanding, because the only Claude record is a `refresh`, not a `scope_authorization_observed` from a fresh authorization. Capturing it requires a new Claude authorization; the existing Claude grant is **not** to be revoked to force one. |
| 104 | **OAuth is not the cause of the ChatGPT "Working" hang.** The same export shows ChatGPT completing consent, authorization code, `/token 200`, and subsequent refreshes. Further diagnosis uses the deployed `mcp_debug` positive-path trace, not more OAuth troubleshooting. |
| 105 | **ChatGPT reconnect grant-rebind (not Slice 6b).** A new OAuth Grant for an existing `oauth_client_id` was inserted as a second `agent_connections` row and hit `agent_connections_client_uidx`; `verifyAccessToken` swallowed that as `401 invalid_token`. `upsertGrantConnection` now rebinds a connected client row to the new grant, then deletes only the superseded Grant's `oauth_models` rows — never `revokeAgentConnection`, which would mark the live connection revoked. Revoked client rows stay rejected. If cleanup of Grant A fails and A remains valid, a later A token cannot steal the binding back from live newer Grant B (`iat` comparison; older or equal incoming is rejected before the update, so Grant B is never destroyed). Report-only `failure_reason` on `mcp_token_verified`: `invalid_token` \| `revoked_connection` \| `connection_conflict`. |
| 106 | **Slice 6b is not complete.** A prototype demonstrated centralized MCP scope enforcement (check at `dispatchTool` before domain work; `insufficient_scope`; `scope_mcp_denied`). The proposed production tool→scope mapping is **rejected**. 6b remains blocked. |
| 107 | **Practical resource capabilities on real tokens are only `identity:read` and `interactions:write`.** ChatGPT `initial_authorization` (decision 100): `openid`, `identity:read`, `interactions:write`. Claude refresh: `identity:read`, `interactions:write`, `offline_access`. Fine-grained names in `scopes_supported` are not what these clients obtain. |
| 108 | **Do not map write authority onto `identity:read`.** That would authorize `create_identity`, invites, `set_relationship_permissions`, and `revoke_agent_connection` / `request_disconnect_agent` under a name that Slice 4 shows to the user as a read. Misleading consent is not acceptable. Domain/principal checks are not an OAuth capability split. |
| 109 | **`interactions:write` as an end-to-end coordination bundle is more defensible** than `identity:read`-for-writes, but it still does not match the advertised taxonomy (`interactions:read`, `proposals:write`, `approvals:write`). |
| 110 | **Fine-grained enforcement cannot safely ship until real clients can genuinely request/obtain those scopes.** Expanding `WWW-Authenticate` might change new Claude requests; ChatGPT already diverges from the hint and is not a reliable live 6b client. Silently expanding requested scopes remains forbidden (decision 101). |
| 111 | **`openid` and `offline_access` are protocol scopes and never authorize MCP tools.** |
| 112 | **Slice 6b remains blocked on:** (1) a coherent final scope model, (2) working ChatGPT live validation, (3) fresh Claude `initial_authorization` evidence (gate 96 / decision 103). Do not revoke the live Claude grant to force (3). |
| 113 | **6b prototype is parked, not shipped.** Durable local branch `prototype/phase3.5-slice6b-scope-enforcement`. Do not merge or push it to production/`main` unless explicitly requested. Keep Slice 6a observability in production. |
| 114 | **Selective pre-Phase-3.5 rollback did not restore ChatGPT.** A diagnostic build on `diagnostic/chatgpt-pre-phase3.5` (`fb6ea26`, Railway `cea6a189`) restored pre-Phase-3.5 consent/DCR/scope behavior while keeping grant-rebind, redirect hardening, production `COOKIE_KEYS`, subject-mismatch protection, and production hiding of `phase-minus1-cli` / `/dev/callback`. Tested 2026-08-30: ChatGPT recognized `@reachmy.ai` but exposed no callable tools. ReachMy received zero ChatGPT traffic (`no /reg`, `/auth`, `/token`, `/mcp`, `oauth_debug`, `mcp_debug`, or `openai-mcp` user-agent). Slices 4, 5, and 6a are ruled out as the cause of the current ChatGPT connector-loading failure. The failure is upstream of ReachMy MCP/OAuth invocation. No further ReachMy rollback is warranted for this symptom. Production was restored to `origin/main` `@ cf7b84a` (Railway `efcbe351`). The diagnostic branch is preserved as evidence; it was not merged. |
| 115 | **Slice 7 complete.** Merged to `main` as `5071c89` (PR #1, 2026-08-30). Actions on `main` passed (`33346182862`): frozen-lockfile install, typecheck, lint, incremental format, `test:unit`, full `pnpm test` (198), and `pnpm smoke:portal` against `DATABASE_URL_DEV`. Railway `20b54dd7` deployed that SHA. Production still contains `cf7b84a` grant-rebind. Slice 6b prototype and `diagnostic/chatgpt-pre-phase3.5` were not merged. Slice 8 not started. |

---

*End of Phase 3.5 plan. Slices 1–5 complete (real-provider regression passed). Slice 6a OAuth
observability deployed; ChatGPT `initial_authorization` captured; Claude `initial_authorization`
still outstanding. Slice 6a diagnostic addendum deployed at `fdd09ee`. Slice 6b remains blocked
(prototype only; production mapping rejected). A 2026-08-30 selective rollback of Slices 4/5/6a
did not restore ChatGPT (decision 114). Slice 7 complete at `5071c89` (decision 115).
Slice 8 not started.*
