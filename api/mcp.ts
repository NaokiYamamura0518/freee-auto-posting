/**
 * Vercel API route that exposes the MCP server over Streamable HTTP.
 *
 * Clients connect via POST /mcp (or /api/mcp) to send JSON-RPC messages.
 * GET /mcp is used for SSE-based streaming responses.
 * DELETE /mcp terminates the session.
 */

import { createServer } from "../src/mcp-server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { IncomingMessage, ServerResponse } from "node:http";

// Maintain a single server & transport instance per serverless invocation.
// In Vercel's serverless model each invocation is short-lived, but we still
// follow the MCP SDK patterns for correctness.

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    const server = createServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    // Connect server to transport
    await server.connect(transport);

    // Delegate HTTP handling to the transport
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP handler error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }
}
