/**
 * ReachMy Portal UI — lightweight Hono HTML style system for Phase 3.
 *
 * Slice 5 establishes the visual foundation; Slices 6–8 should reuse these
 * helpers rather than inventing page-local markup/CSS.
 *
 * Shared pieces:
 * - portalLayout / portalShell styles
 * - portalCard, portalButton, portalStatusBadge, portalConnectionRow
 * - portalField / portalLabel (forms)
 * - portalModal (foundation for Slice 8 disconnect)
 */
import { clerkFrontendApi } from "../auth/clerk.js";
import type { AppConfig } from "../config.js";
import type { PortalConnectionRow, PortalOverview } from "../domain/portal-connections.js";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Centralized Portal CSS tokens + component styles. */
export function portalStyles(): string {
  return `
    :root {
      --rm-bg0: #f3f6f4;
      --rm-bg1: #e8eef0;
      --rm-ink: #152019;
      --rm-muted: #5c6b62;
      --rm-line: #d5ddd8;
      --rm-card: rgba(255, 255, 255, 0.86);
      --rm-accent: #1f6b4a;
      --rm-accent-soft: #e6f2ec;
      --rm-ok: #1f6b4a;
      --rm-ok-soft: #e4f3eb;
      --rm-warn: #6b5a1f;
      --rm-warn-soft: #f4efd9;
      --rm-danger: #8b2e2e;
      --rm-danger-soft: #f7e8e8;
      --rm-radius: 14px;
      --rm-radius-sm: 8px;
      --rm-shadow: 0 10px 30px rgba(21, 32, 25, 0.06);
      --rm-space-1: 0.35rem;
      --rm-space-2: 0.65rem;
      --rm-space-3: 1rem;
      --rm-space-4: 1.5rem;
      --rm-space-5: 2rem;
      --rm-shell: 40rem;
      --rm-font: "Source Sans 3", "Segoe UI", sans-serif;
      --rm-display: "Fraunces", Georgia, serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--rm-font);
      color: var(--rm-ink);
      background:
        radial-gradient(1200px 500px at 10% -10%, #d9ebe2 0%, transparent 55%),
        radial-gradient(900px 420px at 100% 0%, #d7e4ec 0%, transparent 50%),
        linear-gradient(180deg, var(--rm-bg0), var(--rm-bg1));
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--rm-accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .rm-shell {
      width: min(100%, var(--rm-shell));
      margin: 0 auto;
      padding: var(--rm-space-4) var(--rm-space-3) 3rem;
    }
    .rm-appbar {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--rm-space-3);
      margin-bottom: var(--rm-space-5);
    }
    .rm-brand {
      font-family: var(--rm-display);
      font-size: clamp(1.45rem, 4vw, 1.7rem);
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--rm-ink);
      text-decoration: none;
    }
    .rm-brand:hover { text-decoration: none; }
    .rm-nav {
      display: flex;
      flex-wrap: wrap;
      gap: var(--rm-space-3);
      font-size: 0.95rem;
    }
    .rm-nav a { color: var(--rm-muted); }
    .rm-nav a:hover,
    .rm-nav a[aria-current="page"] { color: var(--rm-ink); }

    .rm-h1 {
      font-family: var(--rm-display);
      font-size: 1.2rem;
      font-weight: 600;
      margin: 0 0 var(--rm-space-2);
      letter-spacing: -0.01em;
    }
    .rm-h2 {
      font-family: var(--rm-display);
      font-size: 1.05rem;
      font-weight: 600;
      margin: 0 0 var(--rm-space-2);
    }
    .rm-lead {
      margin: 0 0 var(--rm-space-3);
      color: var(--rm-muted);
      font-size: 1rem;
    }
    .rm-muted { color: var(--rm-muted); }
    .rm-hint {
      color: var(--rm-muted);
      font-size: 0.9rem;
      margin: var(--rm-space-1) 0 0;
    }
    .rm-label {
      display: block;
      font-size: 0.78rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--rm-muted);
      margin: 0 0 var(--rm-space-1);
    }
    .rm-value {
      font-size: 1.35rem;
      font-weight: 600;
      margin: 0;
    }
    .rm-value--muted {
      color: var(--rm-muted);
      font-weight: 500;
      font-size: 1.15rem;
    }
    .rm-stack { display: grid; gap: var(--rm-space-2); }
    .rm-stack--lg { gap: var(--rm-space-3); }

    .rm-card {
      background: var(--rm-card);
      border: 1px solid var(--rm-line);
      border-radius: var(--rm-radius);
      box-shadow: var(--rm-shadow);
      padding: 1.1rem 1.2rem;
      margin-bottom: var(--rm-space-3);
      backdrop-filter: blur(8px);
    }
    .rm-card > :last-child { margin-bottom: 0; }

    .rm-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      border: 1px solid var(--rm-line);
      background: #fff;
      color: var(--rm-ink);
      border-radius: var(--rm-radius-sm);
      padding: 0.55rem 0.95rem;
      font: inherit;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      line-height: 1.2;
    }
    .rm-btn:hover { background: #f7faf8; text-decoration: none; }
    .rm-btn:focus-visible {
      outline: 2px solid var(--rm-accent);
      outline-offset: 2px;
    }
    .rm-btn--primary {
      background: var(--rm-ink);
      border-color: var(--rm-ink);
      color: #fff;
    }
    .rm-btn--primary:hover { background: #243229; }
    .rm-btn--danger {
      background: var(--rm-danger);
      border-color: var(--rm-danger);
      color: #fff;
    }
    .rm-btn--danger:hover { background: #742525; }
    .rm-btn--ghost {
      background: transparent;
      border-color: transparent;
      color: var(--rm-muted);
    }
    .rm-btn--ghost:hover { color: var(--rm-ink); background: rgba(21, 32, 25, 0.04); }
    .rm-btn:disabled,
    .rm-btn--disabled,
    .rm-btn[aria-disabled="true"] {
      opacity: 0.55;
      cursor: not-allowed;
      pointer-events: none;
    }
    .rm-btn-row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--rm-space-2);
      align-items: center;
    }

    .rm-badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 0.18rem 0.6rem;
      font-size: 0.82rem;
      font-weight: 600;
      line-height: 1.3;
      border: 1px solid transparent;
    }
    .rm-badge--connected {
      color: var(--rm-ok);
      background: var(--rm-ok-soft);
      border-color: #c6e4d3;
    }
    .rm-badge--not_connected {
      color: var(--rm-warn);
      background: var(--rm-warn-soft);
      border-color: #e4d9a8;
    }
    .rm-badge--neutral {
      color: var(--rm-muted);
      background: #eef1ef;
      border-color: var(--rm-line);
    }

    .rm-connection-list { display: grid; }
    .rm-connection-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--rm-space-3);
      padding: 0.9rem 0;
      border-top: 1px solid var(--rm-line);
    }
    .rm-connection-row:first-child { border-top: 0; padding-top: 0.15rem; }
    .rm-connection-meta { min-width: 0; }
    .rm-connection-name {
      margin: 0 0 0.2rem;
      font-weight: 600;
      font-size: 1.02rem;
    }
    .rm-connection-actions {
      display: flex;
      flex-shrink: 0;
      gap: var(--rm-space-2);
      align-items: center;
    }

    .rm-field { display: grid; gap: var(--rm-space-1); margin-bottom: var(--rm-space-3); }
    .rm-input,
    .rm-textarea,
    .rm-select {
      width: 100%;
      border: 1px solid var(--rm-line);
      border-radius: var(--rm-radius-sm);
      background: #fff;
      color: var(--rm-ink);
      font: inherit;
      padding: 0.65rem 0.75rem;
    }
    .rm-input:focus,
    .rm-textarea:focus,
    .rm-select:focus {
      outline: 2px solid var(--rm-accent);
      outline-offset: 1px;
      border-color: var(--rm-accent);
    }
    .rm-textarea { min-height: 6rem; resize: vertical; }

    .rm-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(21, 32, 25, 0.42);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--rm-space-3);
      z-index: 40;
    }
    .rm-modal-backdrop[hidden] { display: none; }
    .rm-modal {
      width: min(100%, 26rem);
      background: #fff;
      border: 1px solid var(--rm-line);
      border-radius: var(--rm-radius);
      box-shadow: 0 18px 50px rgba(21, 32, 25, 0.18);
      padding: 1.25rem 1.3rem 1.2rem;
    }
    .rm-modal__title {
      font-family: var(--rm-display);
      font-size: 1.15rem;
      font-weight: 600;
      margin: 0 0 var(--rm-space-2);
    }
    .rm-modal__body {
      margin: 0 0 var(--rm-space-3);
      color: var(--rm-muted);
      font-size: 0.98rem;
    }
    .rm-modal__actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: var(--rm-space-2);
    }

    #clerk-app { margin-top: var(--rm-space-3); min-height: 12rem; }

    @media (max-width: 520px) {
      .rm-shell { padding: 1.15rem 1rem 2.5rem; }
      .rm-connection-row {
        flex-direction: column;
        align-items: flex-start;
      }
      .rm-connection-actions { width: 100%; }
      .rm-connection-actions .rm-btn { width: 100%; }
      .rm-modal__actions { flex-direction: column-reverse; }
      .rm-modal__actions .rm-btn { width: 100%; }
    }
  `;
}

export type PortalNavActive = "home" | "account" | "none";

export function portalLayout(opts: {
  title: string;
  body: string;
  active?: PortalNavActive;
  showNav?: boolean;
}): string {
  const showNav = opts.showNav !== false && opts.active !== "none";
  const nav = showNav
    ? `<nav class="rm-nav" aria-label="Portal">
        <a href="/"${opts.active === "home" ? ' aria-current="page"' : ""}>Home</a>
        <a href="/account"${opts.active === "account" ? ' aria-current="page"' : ""}>Account</a>
      </nav>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(opts.title)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet" />
    <style>${portalStyles()}</style>
  </head>
  <body>
    <div class="rm-shell">
      <header class="rm-appbar">
        <a class="rm-brand" href="/">ReachMy</a>
        ${nav}
      </header>
      <main>${opts.body}</main>
    </div>
  </body>
</html>`;
}

export function portalCard(opts: { body: string; title?: string; className?: string }): string {
  const title = opts.title ? `<h1 class="rm-h1">${escapeHtml(opts.title)}</h1>` : "";
  const extra = opts.className ? ` ${opts.className}` : "";
  return `<section class="rm-card${extra}">${title}${opts.body}</section>`;
}

export type PortalButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export function portalButton(opts: {
  label: string;
  variant?: PortalButtonVariant;
  href?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  attrs?: string;
}): string {
  const variant = opts.variant ?? "secondary";
  const variantClass =
    variant === "primary"
      ? "rm-btn--primary"
      : variant === "danger"
        ? "rm-btn--danger"
        : variant === "ghost"
          ? "rm-btn--ghost"
          : "";
  const disabledClass = opts.disabled ? " rm-btn--disabled" : "";
  const extra = opts.className ? ` ${opts.className}` : "";
  const className = `rm-btn ${variantClass}${disabledClass}${extra}`.trim();
  const attrs = opts.attrs ? ` ${opts.attrs}` : "";
  const disabledAttr = opts.disabled ? ' aria-disabled="true"' : "";

  if (opts.href && !opts.disabled) {
    return `<a class="${className}" href="${escapeHtml(opts.href)}"${attrs}>${escapeHtml(opts.label)}</a>`;
  }
  if (opts.href && opts.disabled) {
    return `<span class="${className}"${disabledAttr}${attrs}>${escapeHtml(opts.label)}</span>`;
  }
  const type = opts.type ?? "button";
  return `<button class="${className}" type="${type}"${opts.disabled ? " disabled" : ""}${attrs}>${escapeHtml(opts.label)}</button>`;
}

export function portalStatusBadge(status: "connected" | "not_connected" | "neutral", label?: string): string {
  const text =
    label ??
    (status === "connected" ? "Connected" : status === "not_connected" ? "Not connected" : "Unknown");
  const cls =
    status === "connected"
      ? "rm-badge--connected"
      : status === "not_connected"
        ? "rm-badge--not_connected"
        : "rm-badge--neutral";
  return `<span class="rm-badge ${cls}">${escapeHtml(text)}</span>`;
}

export function portalConnectionRow(opts: {
  label: string;
  status: "connected" | "not_connected";
  actionHtml: string;
}): string {
  return `<div class="rm-connection-row">
    <div class="rm-connection-meta">
      <p class="rm-connection-name">${escapeHtml(opts.label)}</p>
      ${portalStatusBadge(opts.status)}
    </div>
    <div class="rm-connection-actions">${opts.actionHtml}</div>
  </div>`;
}

export function portalLabel(text: string, forId?: string): string {
  const forAttr = forId ? ` for="${escapeHtml(forId)}"` : "";
  return `<label class="rm-label"${forAttr}>${escapeHtml(text)}</label>`;
}

export function portalField(opts: {
  label: string;
  inputHtml: string;
  hint?: string;
}): string {
  const hint = opts.hint ? `<p class="rm-hint">${escapeHtml(opts.hint)}</p>` : "";
  return `<div class="rm-field">${portalLabel(opts.label)}${opts.inputHtml}${hint}</div>`;
}

/**
 * Modal/dialog foundation for Slice 8 disconnect.
 * Keep hidden by default; later pages toggle with JS.
 */
export function portalModal(opts: {
  id: string;
  title: string;
  bodyHtml: string;
  actionsHtml: string;
  hidden?: boolean;
}): string {
  const hidden = opts.hidden !== false ? " hidden" : "";
  return `<div class="rm-modal-backdrop" id="${escapeHtml(opts.id)}"${hidden} role="presentation">
    <div class="rm-modal" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(opts.id)}-title">
      <h2 class="rm-modal__title" id="${escapeHtml(opts.id)}-title">${escapeHtml(opts.title)}</h2>
      <div class="rm-modal__body">${opts.bodyHtml}</div>
      <div class="rm-modal__actions">${opts.actionsHtml}</div>
    </div>
  </div>`;
}

/** Shared ReachMy MCP connector URL — never per-user, never derived from account IDs. */
export const REACHMY_MCP_CONNECTOR_URL = "https://mcp.reachmy.ai/mcp";

/**
 * Anthropic prefilled custom-connector deep link (Phase 3 §10.1).
 * OAuth still completes on mcp.reachmy.ai after the user confirms in Claude.
 */
export function claudePrefillConnectorUrl(
  connectorUrl: string = REACHMY_MCP_CONNECTOR_URL,
): string {
  const params = new URLSearchParams({
    modal: "add-custom-connector",
    connectorName: "ReachMy",
    connectorUrl,
  });
  return `https://claude.ai/customize/connectors?${params.toString()}`;
}

/**
 * Shared provider-setup shell for Connect Claude / Connect ChatGPT pages.
 * Keep page-specific steps/CTAs in the caller.
 */
export function renderPortalProviderSetup(opts: {
  title: string;
  lead: string;
  bodyHtml: string;
}): string {
  return portalLayout({
    title: `${opts.title} · ReachMy`,
    active: "home",
    body: portalCard({
      title: opts.title,
      body: `
        <p class="rm-lead">${escapeHtml(opts.lead)}</p>
        ${opts.bodyHtml}
      `,
    }),
  });
}

export function renderPortalConnectClaude(): string {
  const continueUrl = claudePrefillConnectorUrl();
  return renderPortalProviderSetup({
    title: "Connect Claude",
    lead: "Add ReachMy to Claude so Claude can represent you on the ReachMy network.",
    bodyHtml: `
      <div class="rm-btn-row" style="margin-bottom: var(--rm-space-3)">
        ${portalButton({
          label: "Continue to Claude",
          variant: "primary",
          href: continueUrl,
          attrs: 'target="_blank" rel="noopener noreferrer"',
        })}
      </div>
      <p class="rm-hint">You’ll review the connection in Claude before anything is authorized.</p>
      <p class="rm-hint">After connecting ReachMy in Claude, return here and refresh to see the updated status.</p>
    `,
  });
}

function connectionAction(row: PortalConnectionRow): string {
  if (row.status === "connected") {
    return portalButton({
      label: "Disconnect",
      disabled: true,
      attrs: 'title="Coming in a later slice"',
    });
  }
  if (row.provider === "claude") {
    return portalButton({
      label: "Connect Claude",
      variant: "primary",
      href: "/connect/claude",
    });
  }
  return portalButton({
    label: "Coming next",
    disabled: true,
    attrs: 'title="Provider connect arrives in a later slice"',
  });
}

export function renderPortalHome(overview: PortalOverview): string {
  const agentName =
    overview.agent_name_status === "claimed" && overview.agent_name
      ? `<p class="rm-value">${escapeHtml(overview.agent_name)}</p>`
      : `<p class="rm-value rm-value--muted">Not claimed yet</p>`;

  const hint =
    overview.agent_name_status === "not_claimed"
      ? `<p class="rm-hint">Claim your Agent Name conversationally in Claude or ChatGPT after you connect.</p>`
      : "";

  const rows = overview.connections
    .map((row) =>
      portalConnectionRow({
        label: row.label,
        status: row.status,
        actionHtml: connectionAction(row),
      }),
    )
    .join("");

  return portalLayout({
    title: "ReachMy",
    active: "home",
    body: [
      portalCard({
        body: `${portalLabel("Agent Name")}${agentName}${hint}`,
      }),
      portalCard({
        title: "Your AI Connections",
        body: `<div class="rm-connection-list">${rows}</div>`,
      }),
    ].join(""),
  });
}

export function renderPortalSignIn(config: AppConfig, redirectTo: string): string {
  const frontend = clerkFrontendApi(config.clerkPublishableKey);
  return portalLayout({
    title: "Sign in · ReachMy",
    active: "none",
    showNav: false,
    body: portalCard({
      title: "Sign in",
      body: `
        <p class="rm-lead">Sign in to open your ReachMy Portal.</p>
        <div id="clerk-app"></div>
        <script>
          const publishableKey = ${JSON.stringify(config.clerkPublishableKey)};
          const redirectTo = ${JSON.stringify(redirectTo)};
          const clerkJs = ${JSON.stringify(`https://${frontend}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`)};
          const script = document.createElement("script");
          script.src = clerkJs;
          script.setAttribute("data-clerk-publishable-key", publishableKey);
          script.onload = async () => {
            const Clerk = window.Clerk;
            await Clerk.load();
            if (!Clerk.user) {
              Clerk.mountSignIn(document.getElementById("clerk-app"));
              return;
            }
            const token = await Clerk.session.getToken();
            await fetch("/v1/auth/clerk", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ token }),
            });
            window.location.href = redirectTo;
          };
          document.head.appendChild(script);
        </script>
      `,
    }),
  });
}

export function renderPortalAccount(input: {
  email: string | null;
  agentName: string | null;
}): string {
  const email = input.email?.trim() || "Signed in";
  const agentName = input.agentName ?? "Not claimed yet";
  return portalLayout({
    title: "Account · ReachMy",
    active: "account",
    body: portalCard({
      title: "Account",
      body: `
        <div class="rm-stack rm-stack--lg">
          <div>
            ${portalLabel("Signed in as")}
            <p class="rm-value" style="font-size:1.1rem">${escapeHtml(email)}</p>
          </div>
          <div>
            ${portalLabel("Agent Name")}
            <p class="rm-value" style="font-size:1.1rem">${escapeHtml(agentName)}</p>
          </div>
          <form method="post" action="/sign-out">
            ${portalButton({ label: "Sign out", type: "submit" })}
          </form>
        </div>
      `,
    }),
  });
}

export function renderPortalSignOut(config: AppConfig): string {
  const frontend = clerkFrontendApi(config.clerkPublishableKey);
  return portalLayout({
    title: "Signing out · ReachMy",
    active: "none",
    showNav: false,
    body: portalCard({
      title: "Signing out…",
      body: `
        <p class="rm-lead">Clearing your ReachMy Portal session.</p>
        <script>
          const publishableKey = ${JSON.stringify(config.clerkPublishableKey)};
          const clerkJs = ${JSON.stringify(`https://${frontend}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`)};
          const script = document.createElement("script");
          script.src = clerkJs;
          script.setAttribute("data-clerk-publishable-key", publishableKey);
          script.onload = async () => {
            try {
              const Clerk = window.Clerk;
              await Clerk.load();
              if (Clerk.session) {
                await Clerk.signOut();
              }
            } catch (_) {}
            window.location.href = "/sign-in";
          };
          script.onerror = () => { window.location.href = "/sign-in"; };
          document.head.appendChild(script);
        </script>
      `,
    }),
  });
}
