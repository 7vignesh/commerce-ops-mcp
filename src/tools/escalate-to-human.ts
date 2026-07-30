import { z } from "zod";
import { transaction, queryOne } from "../db/index.js";
import { createEscalation } from "../guards/safety.js";

export const escalateToHumanSchema = z.object({
  orderId: z.string().describe("The order ID this escalation is about (e.g. ORD-1019)"),
  reason: z.string().min(10).describe("Detailed reason for escalation (minimum 10 characters). Explain why automated resolution is not appropriate."),
  priority: z.enum(["low", "medium", "high", "critical"]).describe("Priority level: low (informational), medium (needs review within 24h), high (needs review within 4h), critical (immediate attention required)"),
  evidence: z.object({
    orderStatus: z.string().optional().describe("Current order status"),
    shipmentStatus: z.string().optional().describe("Current shipment status"),
    paymentStatus: z.string().optional().describe("Current payment status"),
    customerRiskScore: z.number().optional().describe("Customer risk score if relevant"),
    additionalContext: z.string().optional().describe("Any additional context for the reviewer"),
  }).describe("Evidence collected during investigation to help the human reviewer"),
});

export type EscalateToHumanInput = z.infer<typeof escalateToHumanSchema>;

export async function escalateToHuman(input: EscalateToHumanInput): Promise<object> {
  const { orderId, reason, priority, evidence } = input;

  // Verify order exists
  const order = await queryOne("SELECT id, status FROM orders WHERE id = $1", [orderId]);
  if (!order) {
    return { found: false, message: `Order ${orderId} not found` };
  }

  const idempotencyKey = `escalate_${orderId}_${priority}_${Date.now().toString(36)}`;

  const result = await transaction(async (client) => {
    return createEscalation(
      client,
      orderId,
      "escalate",
      reason,
      priority,
      {
        ...evidence,
        escalatedBy: "mcp_tool",
        escalatedAt: new Date().toISOString(),
      },
      idempotencyKey
    );
  });

  return {
    success: true,
    escalationId: result.escalationId,
    priority,
    status: "pending_approval",
    message: `Case escalated for human review. Priority: ${priority}. A team member will review this within the expected SLA.`,
    sla: priority === "critical" ? "Immediate" : priority === "high" ? "4 hours" : priority === "medium" ? "24 hours" : "48 hours",
  };
}
