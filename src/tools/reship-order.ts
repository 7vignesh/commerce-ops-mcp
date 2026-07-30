import { z } from "zod";
import { transaction, queryOne } from "../db/index.js";
import { createEscalation } from "../guards/safety.js";

export const reshipOrderSchema = z.object({
  orderId: z.string().describe("The order ID to request reshipment for (e.g. ORD-1019)"),
  reason: z.string().min(10).describe("Detailed reason for the reship request (minimum 10 characters). Required for audit."),
});

export type ReshipOrderInput = z.infer<typeof reshipOrderSchema>;

export async function reshipOrder(input: ReshipOrderInput): Promise<object> {
  const { orderId, reason } = input;

  // Gather order and shipment evidence
  const order = await queryOne(
    `SELECT o.*, c.name as customer_name, c.risk_score, 
            s.status as shipment_status, s.carrier, s.tracking_number
     FROM orders o
     JOIN customers c ON o.customer_id = c.id
     LEFT JOIN shipments s ON s.order_id = o.id
     WHERE o.id = $1`,
    [orderId]
  );

  if (!order) {
    return { found: false, message: `Order ${orderId} not found` };
  }

  // Check if there's a valid reason for reship
  if (!order.shipment_status || !["lost", "returned", "delivered"].includes(order.shipment_status)) {
    return {
      found: true,
      canReship: false,
      message: `Order ${orderId} shipment status is "${order.shipment_status || "none"}" — reship typically requires a lost, returned, or disputed delivered shipment.`,
    };
  }

  // Determine priority
  let priority = "medium";
  if (order.shipment_status === "lost") {
    priority = "high";
  }

  // Always escalate — never auto-reship
  const idempotencyKey = `reship_${orderId}_${Date.now().toString(36)}`;

  const result = await transaction(async (client) => {
    return createEscalation(
      client,
      orderId,
      "reship_request",
      reason,
      priority,
      {
        orderStatus: order.status,
        shipmentStatus: order.shipment_status,
        carrier: order.carrier,
        trackingNumber: order.tracking_number,
        customerName: order.customer_name,
        customerRiskScore: order.risk_score,
        orderAmount: parseFloat(order.total_amount),
      },
      idempotencyKey
    );
  });

  return {
    found: true,
    reshipProcessed: false,
    escalated: true,
    escalationId: result.escalationId,
    priority,
    message: `Reship request for order ${orderId} has been escalated for human review. Priority: ${priority}.`,
    evidence: {
      shipmentStatus: order.shipment_status,
      carrier: order.carrier,
    },
  };
}
