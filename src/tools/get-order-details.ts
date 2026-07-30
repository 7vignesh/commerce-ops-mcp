import { z } from "zod";
import { queryOne, query } from "../db/index.js";

export const getOrderDetailsSchema = z.object({
  orderId: z.string().describe("The order ID to retrieve full details for (e.g. ORD-1001)"),
});

export type GetOrderDetailsInput = z.infer<typeof getOrderDetailsSchema>;

export async function getOrderDetails(input: GetOrderDetailsInput): Promise<object> {
  const { orderId } = input;

  const order = await queryOne(
    `SELECT o.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone, c.risk_score
     FROM orders o JOIN customers c ON o.customer_id = c.id
     WHERE o.id = $1`,
    [orderId]
  );

  if (!order) {
    return { found: false, message: `Order ${orderId} not found` };
  }

  const payment = await queryOne("SELECT * FROM payments WHERE order_id = $1", [orderId]);
  const shipment = await queryOne("SELECT * FROM shipments WHERE order_id = $1", [orderId]);
  const actions = await query(
    "SELECT * FROM action_log WHERE order_id = $1 ORDER BY created_at DESC",
    [orderId]
  );

  return {
    found: true,
    order: {
      id: order.id,
      status: order.status,
      items: order.items,
      totalAmount: parseFloat(order.total_amount),
      createdAt: order.created_at,
      updatedAt: order.updated_at,
    },
    customer: {
      id: order.customer_id,
      name: order.customer_name,
      email: order.customer_email,
      phone: order.customer_phone,
      riskScore: order.risk_score,
    },
    payment: payment
      ? {
          id: payment.id,
          method: payment.method,
          status: payment.status,
          amount: parseFloat(payment.amount),
          failureReason: payment.failure_reason,
          refundedAmount: parseFloat(payment.refunded_amount),
          refundedAt: payment.refunded_at,
        }
      : null,
    shipment: shipment
      ? {
          id: shipment.id,
          carrier: shipment.carrier,
          trackingNumber: shipment.tracking_number,
          status: shipment.status,
          estimatedDelivery: shipment.estimated_delivery,
          actualDelivery: shipment.actual_delivery,
          lastUpdate: shipment.last_update,
        }
      : null,
    actionHistory: actions.map((a: any) => ({
      id: a.id,
      action: a.action,
      reason: a.reason,
      details: a.details,
      status: a.status,
      priority: a.priority,
      timestamp: a.created_at,
    })),
  };
}
