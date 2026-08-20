import type { AppConfig } from "../config.js";
import { hostnameFromUrl } from "../config.js";

export type RequestHostKind = "portal" | "mcp" | "unknown";

const LOCAL_MCP_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Hostnames that may serve MCP/OAuth/API (excluding the Portal host). */
export function mcpHostnames(config: AppConfig): Set<string> {
  const hosts = new Set<string>();
  hosts.add(hostnameFromUrl(config.publicUrl));
  for (const host of config.allowedHosts) {
    if (host !== config.portalHost) hosts.add(host);
  }
  return hosts;
}

export function normalizeHostname(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  return trimmed.split(":")[0] ?? "";
}

export function classifyRequestHost(hostname: string, config: AppConfig): RequestHostKind {
  if (!hostname) return "unknown";
  if (hostname === config.portalHost.toLowerCase()) return "portal";
  if (mcpHostnames(config).has(hostname)) return "mcp";
  return "unknown";
}

/** MCP/OAuth/API paths that must not be served from the Portal hostname. */
export function isMcpBackendPath(pathname: string): boolean {
  if (pathname === "/mcp") return true;
  if (pathname.startsWith("/auth")) return true;
  if (pathname.startsWith("/token")) return true;
  if (pathname === "/reg" || pathname.startsWith("/reg/")) return true;
  if (pathname.startsWith("/interaction/")) return true;
  if (pathname.startsWith("/.well-known/")) return true;
  if (pathname === "/jwks") return true;
  if (pathname.startsWith("/v1")) return true;
  if (
    pathname === "/sign-in" ||
    pathname === "/recovery" ||
    pathname === "/security" ||
    pathname === "/dev/callback" ||
    pathname.startsWith("/invite/")
  ) {
    return true;
  }
  return false;
}

/** Paths allowed on the Portal hostname. */
export function isPortalHostAllowedPath(method: string, pathname: string): boolean {
  if (method === "GET" && pathname === "/v1/portal/overview") return true;
  if (method === "POST" && pathname === "/v1/auth/clerk") return true;
  if (method === "POST" && pathname === "/sign-out") return true;
  if (method !== "GET") return false;
  return (
    pathname === "/" ||
    pathname === "/health" ||
    pathname === "/admin" ||
    pathname === "/sign-in" ||
    pathname === "/account" ||
    pathname === "/connect/claude"
  );
}

/** @deprecated Use isPortalHostAllowedPath */
export function isPortalSlice0Path(method: string, pathname: string): boolean {
  return isPortalHostAllowedPath(method, pathname);
}

export function isLocalMcpHost(hostname: string): boolean {
  return LOCAL_MCP_HOSTS.has(hostname);
}
