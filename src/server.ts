import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "crypto";
import { initializeDatabase } from "./db/index.js";
import { lookupOrder, lookupOrderSchema } from "./tools/lookup-order.js";
import { getOrderDetails, getOrderDetailsSchema } from "./tools/get-order-details.js";
import { checkPaymentStatus, checkPaymentStatusSchema } from "./tools/check-payment-status.js";
import { checkShipmentStatus, checkShipmentStatusSchema } from "./tools/check-shipment-status.js";
import { getCustomerHistory, getCustomerHistorySchema } from "./tools/get-customer-history.js";
import { issueRefund, issueRefundSchema } from "./tools/issue-refund.js";
import { cancelOrder, cancelOrderSchema } from "./tools/cancel-order.js";
import { reshipOrder, reshipOrderSchema } from "./tools/reship-order.js";
import { escalateToHuman, escalateToHumanSchema } from "./tools/escalate-to-human.js";

// Initialize database
// Deliberately not awaited at module scope: if the database is unreachable the
// process must still bind a port, otherwise the platform healthcheck sees a
// dead container and reports a generic 502 instead of the real cause.
let dbReady = false;
let dbError: string | null = null;

const dbInit = initializeDatabase()
  .then(() => {
    dbReady = true;
    console.log("database ready");
  })
  .catch((err) => {
    dbError = err instanceof Error ? err.message : String(err);
    console.error("database initialization failed:", dbError);
  });

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "commerce-ops",
    version: "1.0.0",
  });

  // === QUERY TOOLS (read-only, safe) ===

  server.tool(
    "lookup_order",
    "Search for orders by order ID, customer email, or phone number. Use this as the FIRST step when a customer contacts about a missing delivery. Returns matching orders with basic status info.",
    lookupOrderSchema.shape,
    async (params) => {
      const result = await lookupOrder(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_order_details",
    "Retrieve full details for a specific order including line items, amounts, payment info, shipment tracking, customer risk score, and action history. Use after identifying the order to understand the complete picture before deciding on resolution.",
    getOrderDetailsSchema.shape,
    async (params) => {
      const result = await getOrderDetails(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "check_payment_status",
    "Check the payment status for an order. Returns payment method, status (success/failed/pending/refunded), failure reasons, and refund details. Use to verify payment was successful before considering a refund.",
    checkPaymentStatusSchema.shape,
    async (params) => {
      const result = await checkPaymentStatus(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "check_shipment_status",
    "Check shipment and delivery status for an order. Returns carrier info, tracking number, status, delay info, and whether a CARRIER EXCEPTION exists (lost/returned). A verified carrier exception is REQUIRED before issuing a refund for missing delivery.",
    checkShipmentStatusSchema.shape,
    async (params) => {
      const result = await checkShipmentStatus(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_customer_history",
    "Retrieve a customer's complete history including all past orders, total spending, refund count, risk score, and recent actions. Use to assess customer relationship and risk before deciding on resolution. Risk score >= 70 means the customer is HIGH RISK and auto-refund is not allowed.",
    getCustomerHistorySchema.shape,
    async (params) => {
      const result = await getCustomerHistory(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // === ACTION TOOLS (mutations with safety guardrails) ===

  server.tool(
    "issue_refund",
    `Issue a refund for a missing-delivery order. The server enforces ALL eligibility conditions automatically:
    1. Amount must be <= $150
    2. Amount must not exceed the paid amount
    3. Order must be no more than 30 days old
    4. Customer risk score must be below 70
    5. A carrier exception must be verified (shipment status: lost or returned)
    6. No existing refund for this order
    If ANY condition fails, the refund is automatically escalated for manager approval instead. This is an idempotent operation.`,
    issueRefundSchema.shape,
    async (params) => {
      const result = await issueRefund(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "cancel_order",
    "Request cancellation of an order. This tool NEVER cancels automatically — it always creates a human-review escalation with the gathered evidence and appropriate priority. Use when a customer wants to cancel, regardless of order state.",
    cancelOrderSchema.shape,
    async (params) => {
      const result = await cancelOrder(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "reship_order",
    "Request reshipment of an order. This tool NEVER reships automatically — it always creates a human-review escalation with shipment evidence and appropriate priority. Use when a customer's delivery is confirmed lost or returned and they prefer a reship over a refund.",
    reshipOrderSchema.shape,
    async (params) => {
      const result = await reshipOrder(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "escalate_to_human",
    "Escalate a case to a human operator for manual review. Use when: (1) automated resolution is not appropriate, (2) the situation is ambiguous, (3) the customer is high-risk, (4) the issue falls outside the missing-delivery workflow, or (5) you are unsure about the right action. Always provide detailed evidence and context.",
    escalateToHumanSchema.shape,
    async (params) => {
      const result = await escalateToHuman(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

// Set up Express app
const app = express();
app.use(express.json());

// Store active transports by session ID
const transports = new Map<string, StreamableHTTPServerTransport>();

// Health check
app.get("/health", (_req, res) => {
  res.status(dbReady ? 200 : 503).json({
    status: dbReady ? "ok" : "degraded",
    server: "commerce-ops-mcp",
    version: "1.0.0",
    database: dbReady ? "connected" : "unavailable",
    ...(dbError ? { databaseError: dbError } : {}),
  });
});

// MCP Streamable HTTP endpoint
app.post("/mcp", async (req, res) => {
  // Tools all read from Postgres, so wait for the initial connection rather
  // than failing with an opaque error on a cold start.
  await dbInit;
  if (!dbReady) {
    res.status(503).json({ error: `Database unavailable: ${dbError ?? "unknown"}` });
    return;
  }

  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session — reuse transport
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
    } else if (!sessionId) {
      // New session — create transport and connect
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);

      // Clean up on transport close
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      await transport.handleRequest(req, res, req.body);

      // Session ID is only available after handleRequest
      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }
    } else {
      // Session ID provided but not found (expired/invalid)
      res.status(404).json({ error: "Session not found. Please reinitialize." });
    }
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Handle GET for SSE stream
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid or missing session ID" });
  }
});

// Handle DELETE for session cleanup
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.close();
    transports.delete(sessionId);
    res.status(200).json({ message: "Session closed" });
  } else {
    res.status(400).json({ error: "Invalid or missing session ID" });
  }
});

const PORT = parseInt(process.env.PORT || "3000", 10);
// Bind 0.0.0.0 so the container is reachable from outside, not just loopback.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Commerce Ops MCP Server listening on 0.0.0.0:${PORT}`);
  console.log(`   Health: /health`);
  console.log(`   MCP:    /mcp`);
});
