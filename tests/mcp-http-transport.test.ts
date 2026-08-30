/**
 * Real `POST /mcp` coverage: bearer verification, Streamable HTTP framing, and `tools/call`
 * completion over the transport ChatGPT and Claude actually use.
 *
 * Every other MCP test calls `executeTool` directly, which cannot observe an exchange that
 * answers HTTP 200 and then never finishes its stream — the failure mode under investigation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setClerkBrowserSessionResolverForTests } from "../src/auth/browser-account.js";
import { hostnameFromUrl, type AppConfig } from "../src/config.js";
import { httpRequest, withServerOnPublicUrlPort, type HttpResult } from "./helpers-http.js";
import { obtainOAuthAccessToken } from "./helpers-oauth-token.js";
import { makePrincipal, testDb } from "./helpers.js";

const MCP_ACCEPT = "application/json, text/event-stream";

const EXPECTED_MCP_TOOLS = [
  "get_my_identity",
  "get_identity",
  "create_identity",
  "resolve_identity",
  "create_invite",
  "accept_invite",
  "list_connections",
  "get_relationship_permissions",
  "set_relationship_permissions",
  "create_interaction",
  "list_pending_interactions",
  "get_interaction",
  "respond_to_interaction",
  "create_proposal",
  "approve_proposal",
  "reject_proposal",
  "list_agent_connections",
  "request_disconnect_agent",
  "revoke_agent_connection",
];

type McpLog = Record<string, unknown>;

function captureMcpLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: McpLog[] }> {
  const logs: McpLog[] = [];
  const original = console.log;
  console.log = ((msg: unknown, ...rest: unknown[]) => {
    if (typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg) as McpLog;
        if (parsed.msg === "mcp_debug") logs.push(parsed);
      } catch {
        // not structured mcp output
      }
    }
    return original.call(console, msg, ...rest);
  }) as typeof console.log;
  return fn()
    .then((result) => ({ result, logs }))
    .finally(() => {
      console.log = original;
    });
}

function mcpPost(
  port: number,
  config: AppConfig,
  body: unknown,
  options: { token?: string; accept?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { accept: options.accept ?? MCP_ACCEPT };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return httpRequest(port, hostnameFromUrl(config.publicUrl), "/mcp", {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify(body),
    headers,
  });
}

/** Pulls JSON-RPC payloads out of an SSE body, or parses a plain JSON body. */
function readRpcMessages(res: HttpResult): Record<string, unknown>[] {
  const contentType = String(res.headers["content-type"] ?? "");
  if (contentType.includes("text/event-stream")) {
    return res.body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice("data:".length).trim()) as Record<string, unknown>);
  }
  if (!res.body) return [];
  const parsed = JSON.parse(res.body) as unknown;
  return (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
}

function toolPayload(res: HttpResult): Record<string, unknown> {
  const [message] = readRpcMessages(res);
  assert.ok(message, "expected a JSON-RPC message");
  const result = message!.result as { content?: Array<{ text?: string }>; isError?: boolean };
  assert.ok(result, `expected a result, got ${JSON.stringify(message)}`);
  const text = result.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text!) as Record<string, unknown>;
}

const initializeBody = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "transport-test", version: "0" },
  },
});

async function connectedToken(port: number, config: AppConfig): Promise<string> {
  const db = await testDb();
  const { identity } = await makePrincipal(db, "mcptransport");
  return obtainOAuthAccessToken(port, config, identity.account_id);
}

test("MCP transport: unauthenticated POST /mcp is refused with an OAuth challenge", async () => {
  await withServerOnPublicUrlPort(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const { result: res, logs } = await captureMcpLogs(() =>
      mcpPost(port, config, initializeBody(1)),
    );

    assert.equal(res.status, 401);
    assert.match(String(res.headers["www-authenticate"]), /Bearer realm="reachmy.ai"/);

    const verified = logs.find((entry) => entry.event === "mcp_token_verified");
    assert.equal(verified?.ok, false);
    assert.equal(verified?.failure_reason, "invalid_token");
  });
});

test("MCP transport: initialize completes over Streamable HTTP", async () => {
  await withServerOnPublicUrlPort(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const token = await connectedToken(port, config);
    const res = await mcpPost(port, config, initializeBody(1), { token });

    assert.equal(res.status, 200);
    const [message] = readRpcMessages(res);
    const result = message!.result as { protocolVersion?: string; serverInfo?: { name?: string } };
    assert.ok(result.protocolVersion);
    assert.equal(result.serverInfo?.name, "reachmy-ai");
  });
});

test("MCP transport: tools/list advertises every mapped tool", async () => {
  await withServerOnPublicUrlPort(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const token = await connectedToken(port, config);
    const res = await mcpPost(port, config, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { token });

    assert.equal(res.status, 200);
    const [message] = readRpcMessages(res);
    const tools = (message!.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...EXPECTED_MCP_TOOLS].sort());
  });
});

test("MCP transport: tools/call returns an identity result and terminates the stream", async () => {
  await withServerOnPublicUrlPort(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const token = await connectedToken(port, config);
    const res = await mcpPost(
      port,
      config,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_my_identity", arguments: {} } },
      { token },
    );

    assert.equal(res.status, 200);
    // The body arriving complete is the proof the SSE stream closed rather than hanging open.
    const identity = toolPayload(res);
    assert.equal(typeof identity.agent_name, "string");
    assert.equal(identity.onboarding, "complete");
  });
});

test("MCP transport: notifications are acknowledged without a body", async () => {
  await withServerOnPublicUrlPort(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const token = await connectedToken(port, config);
    const res = await mcpPost(
      port,
      config,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { token },
    );

    assert.equal(res.status, 202);
  });
});

test("MCP transport: a client that will not accept text/event-stream is rejected, not hung", async () => {
  await withServerOnPublicUrlPort(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const token = await connectedToken(port, config);
    const res = await mcpPost(port, config, initializeBody(4), { token, accept: "application/json" });

    assert.equal(res.status, 406);
  });
});

test("MCP transport: one tool call is traceable end to end under a single request id", async () => {
  await withServerOnPublicUrlPort(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const token = await connectedToken(port, config);
    const { logs } = await captureMcpLogs(() =>
      mcpPost(
        port,
        config,
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "get_my_identity", arguments: {} },
        },
        { token },
      ),
    );

    const call = logs.filter((entry) => entry.event === "mcp_method_received");
    assert.equal(call.length, 1);
    const requestId = call[0]!.request_id;
    assert.equal(typeof requestId, "string");

    const forRequest = logs.filter((entry) => entry.request_id === requestId);
    const order = forRequest.map((entry) => entry.event);
    // `mcp_response_started` lands mid-tool because the SDK answers with SSE headers before the
    // tool returns. That is precisely why an HTTP 200 on /mcp says nothing about completion, and
    // why `mcp_response_completed` is the event that does.
    assert.deepEqual(order, [
      "mcp_request_received",
      "mcp_token_verified",
      "mcp_method_received",
      "mcp_tool_call_started",
      "mcp_response_started",
      "mcp_tool_call_completed",
      "mcp_response_completed",
    ]);

    const method = forRequest.find((entry) => entry.event === "mcp_method_received")!;
    assert.equal(method.rpc_method, "tools/call");
    assert.equal(method.tool_name, "get_my_identity");

    const completed = forRequest.find((entry) => entry.event === "mcp_tool_call_completed")!;
    assert.equal(completed.is_error, false);

    const response = forRequest.find((entry) => entry.event === "mcp_response_completed")!;
    assert.equal(response.completed, true);
    assert.equal(response.status, 200);
    assert.ok(Number(response.bytes) > 0);

    const serialized = JSON.stringify(forRequest);
    assert.doesNotMatch(serialized, /access_token|refresh_token|code_verifier|an_session/i);
    assert.doesNotMatch(serialized, new RegExp(token.slice(0, 24)));
  });
});
