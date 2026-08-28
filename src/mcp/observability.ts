import { randomUUID } from "node:crypto";

/**
 * Report-only tracing for the MCP transport (Phase 3.5 Slice 6a diagnostic addendum).
 *
 * Successful `/mcp` traffic previously emitted nothing, so an HTTP 200 could mean a completed
 * exchange or SSE headers followed by a stall. These events make one request followable end to
 * end. Nothing here participates in authorization, transport, or protocol decisions, and
 * `logMcp` never throws into the request it describes.
 *
 * Uses its own `mcp_debug` message so it is searchable separately from `oauth_debug`.
 */

/** Redacted outright. Correlation ids (`client_id`, `grant_id`, `request_id`) are allowed. */
const SENSITIVE_KEY =
  /^(authorization|access_token|refresh_token|id_token|token|authorization_code|code|code_verifier|code_challenge|client_secret|cookie|set-cookie|an_session|_session|_interaction)$/i;

const MAX_TEXT_LENGTH = 200;

export function newMcpRequestId(): string {
  return randomUUID();
}

/** Header values are attacker-influenced; cap them before they reach the log stream. */
export function truncate(value: string | null | undefined, max = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== "string") return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function logMcp(event: string, fields: Record<string, unknown> = {}): void {
  try {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (SENSITIVE_KEY.test(key)) continue;
      safe[key] = value;
    }
    console.log(
      JSON.stringify({
        msg: "mcp_debug",
        event,
        ts: new Date().toISOString(),
        ...safe,
      }),
    );
  } catch {
    // Diagnostics must never affect the request they are describing.
  }
}

export type JsonRpcSummary = {
  rpc_method: string | null;
  tool_name: string | null;
  rpc_id: string | null;
  batch_size: number | null;
  is_notification: boolean;
};

function summarizeSingle(message: unknown): JsonRpcSummary {
  const empty: JsonRpcSummary = {
    rpc_method: null,
    tool_name: null,
    rpc_id: null,
    batch_size: null,
    is_notification: false,
  };
  if (!message || typeof message !== "object") return empty;
  const record = message as Record<string, unknown>;
  const method = typeof record.method === "string" ? record.method : null;
  const id = record.id;
  const params = record.params;
  const toolName =
    method === "tools/call" && params && typeof params === "object"
      ? truncate(String((params as Record<string, unknown>).name ?? ""), 80)
      : null;
  return {
    rpc_method: truncate(method, 80),
    tool_name: toolName || null,
    rpc_id: typeof id === "string" || typeof id === "number" ? String(id) : null,
    batch_size: null,
    is_notification: method !== null && id === undefined,
  };
}

/**
 * Method/tool identity for a parsed JSON-RPC body. Names and ids only — never argument values,
 * which may carry user data.
 */
export function describeJsonRpc(body: unknown): JsonRpcSummary {
  if (Array.isArray(body)) {
    const first = summarizeSingle(body[0]);
    return { ...first, batch_size: body.length };
  }
  return summarizeSingle(body);
}

export type ResponseTraceOutcome = {
  completed: boolean;
  bytes: number;
  reason: string | null;
};

/**
 * Wraps a response body so stream completion is observable, mirroring the pump the MCP SDK uses
 * for the same purpose on its legacy leg. `completed` is false when the client cancels or the
 * stream errors — the signal that separates "ReachMy answered" from "ReachMy never finished".
 */
export function traceResponseBody(
  response: Response,
  onSettled: (outcome: ResponseTraceOutcome) => void,
): Response {
  if (!response.body) {
    onSettled({ completed: true, bytes: 0, reason: null });
    return response;
  }

  const reader = response.body.getReader();
  let bytes = 0;
  let settled = false;
  const settle = (completed: boolean, reason: string | null) => {
    if (settled) return;
    settled = true;
    try {
      onSettled({ completed, bytes, reason });
    } catch {
      // Never surface diagnostic failures to the client.
    }
  };

  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          settle(true, null);
          controller.close();
          return;
        }
        if (value !== undefined) {
          bytes += value.byteLength;
          controller.enqueue(value);
        }
      } catch (error) {
        settle(false, "stream_error");
        controller.error(error);
      }
    },
    cancel: (reason) => {
      settle(false, "client_cancelled");
      return reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
