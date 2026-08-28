# Phase 3.5 — Security Hardening & Repository Hygiene

**Status:** Plan **approved** 2026-08-27. **Slices 1–4 complete.** Slices 5–8 not started.
Slice 4 is implemented and covered by automated tests; its **required real-provider regression is
still outstanding** (see §7 Slice 4).
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
| 5 | DCR policy + metadata validation | Medium | 4 |
| 6a | Scope observability (report-only) | Low | 3 |
| 6b | Scope issuance + enforcement | **High** | 6a, 4 |
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

---

### Slice 6b — Scope issuance + enforcement

**Objective.** Stop over-granting resource scopes. Enforce scopes at the MCP boundary.

**Approach.** Fix `src/auth/oidc.ts:70` to grant requested/intersected resource scopes rather than
the full set. Narrow the `scope_defaulted` middleware (`:209-215`) from "everything" to a minimal
baseline. Add `identity:write`. Flip the report-only check to enforcing.

**Compatibility.** Existing production grants already carry full resource scope and continue to
work. The risk is **new** grants for clients that request narrowly — which Phase 2 observed for
ChatGPT. Slice 6a data determines the safe baseline.

**Files.** `src/auth/oidc.ts`, `src/mcp/tools.ts`, `src/mcp/server.ts`.

**Acceptance.**
- Token scope reflects what was requested and authorized, not the full set
- Tool call without the required scope → clean OAuth-shaped error, not a 500
- Pre-existing full-scope grants still work
- Domain authorization unchanged and still authoritative
- Claude and ChatGPT both complete a full lifecycle: identity → invite → coordinate → propose →
  approve → `AGREED`

**Tests.** Token carries only requested scopes; each tool denied without its scope and allowed with
it; legacy full-scope grant regression test.

**Manual validation.** **Required, and the most important in the phase.** Full real-provider
regression on both Claude and ChatGPT. Have a rollback plan ready.

---

### Slice 7 — CI, lint, format, test discovery

**Objective.** Lightweight automated engineering gates. No complicated build or release system.

**Approach.** ESLint (typescript-eslint) + Prettier with a config that does not churn history.
Replace the hand-enumerated `test` script with glob-based discovery. Typecheck `tests/` (currently
excluded by `tsconfig.json:15`).

**CI constraint (real).** The suite requires a live Neon dev database and Clerk keys. CI must
therefore run in two tiers:

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
- [ ] CI / lint / format / test gates exist and pass
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

---

*End of Phase 3.5 plan. Slices 1–4 complete (Slice 4 pending real-provider regression). Slice 5 (DCR
policy + client metadata validation) is next and has not started.*
