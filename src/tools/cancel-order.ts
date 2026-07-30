import { z } from "zod";
import { transaction, queryOne } from "../db/index.js";
import { createEscalation } from "../guards/safety.js";

export const cancelOrderSchema = z.object({
  orderId: z.string().describe("The order ID to request cancellation for (e.g. ORD-1001)"),
  reason: z.string().min(10).describe("Detailed reason for the cancellation request (minimum 10 characters). Required for audit."),
});

export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

export async function cancelOrder(input: CancelOrderInput): Promise<object> {
  const { orderId, reason } = input;

  // Gather order state for the escalation evidence
  const order = await queryOne(
    `SELECT o.*, c.name as customer_name, c.risk_score, p.status as payment_status, 
            p.amount as paid_amount, s.status as shipment_status
     FROM orders o
     JOIN customers c ON o.customer_id = c.id
     LEFT JOIN payments p ON p.order_id = o.id
     LEFT JOIN shipments s ON s.order_id = o.id
     WHERE o.id = $1`,
    [orderId]
  );

  if (!order) {
    return { found: false, message: `Order ${orderId} not found` };
  }

  // Check if already cancelled
  if (order.status === "cancelled") {
    return {
      found: true,
      alreadyCancelled: true,
      message: `Order ${orderId} is already cancelled.`,
    };
  }

  // Determine priority based on order state
  let priority = "medium";
  if (order.status === "shipped" || order.shipment_status === "in_transit") {
    priority = "high"; // Harder to cancel if already shipped
  }
  if (order.status === "delivered") {
    priority = "critical"; // Cannot cancel delivered order
  }

  // Always escalate — never auto-cancel
  const idempotencyKey = `cancel_${orderId}_${Date.now().toString(36)}`;

  const result = await transaction(async (client) => {
    return createEscalation(
      client,
      orderId,
      "cancel_request",
      reason,
      priority,
      {
        orderStatus: order.status,
        paymentStatus: order.payment_status,
        shipmentStatus: order.shipment_status,
        paidAmount: order.paid_amount ? parseFloat(order.paid_amount) : null,
        customerName: order.customer_name,
        customerRiskScore: order.risk_score,
      },
      idempotencyKey
    );
  });

  return {
    found: true,
    cancelProcessed: false,
    escalated: true,
    escalationId: result.escalationId,
    priority,
    message: `Cancellation request for order ${orderId} has been escalated for human review. Priority: ${priority}.`,
    orderState: {
      status: order.status,
      shipmentStatus: order.shipment_status,
    },
  };
}
