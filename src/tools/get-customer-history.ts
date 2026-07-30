import { z } from "zod";
import { queryOne, query } from "../db/index.js";

export const getCustomerHistorySchema = z.object({
  customerId: z.string().describe("The customer ID to retrieve history for (e.g. cust_001)"),
});

export type GetCustomerHistoryInput = z.infer<typeof getCustomerHistorySchema>;

export async function getCustomerHistory(input: GetCustomerHistoryInput): Promise<object> {
  const { customerId } = input;

  const customer = await queryOne("SELECT * FROM customers WHERE id = $1", [customerId]);

  if (!customer) {
    return { found: false, message: `Customer ${customerId} not found` };
  }

  const orders = await query(
    `SELECT o.id, o.status, o.total_amount, o.created_at
     FROM orders o WHERE o.customer_id = $1
     ORDER BY o.created_at DESC`,
    [customerId]
  );

  const payments = await query(
    `SELECT p.status, p.refunded_amount
     FROM payments p JOIN orders o ON p.order_id = o.id
     WHERE o.customer_id = $1`,
    [customerId]
  );

  const actions = await query(
    `SELECT al.order_id, al.action, al.reason, al.status, al.priority, al.created_at
     FROM action_log al JOIN orders o ON al.order_id = o.id
     WHERE o.customer_id = $1
     ORDER BY al.created_at DESC`,
    [customerId]
  );

  const totalSpent = orders
    .filter((o: any) => !["cancelled", "failed"].includes(o.status))
    .reduce((sum: number, o: any) => sum + parseFloat(o.total_amount), 0);

  const refundCount = payments.filter((p: any) => parseFloat(p.refunded_amount) > 0).length;
  const totalRefunded = payments.reduce((sum: number, p: any) => sum + parseFloat(p.refunded_amount), 0);
  const failedOrderCount = orders.filter((o: any) => o.status === "failed").length;
  const escalationCount = actions.filter((a: any) => a.action === "escalate").length;

  return {
    found: true,
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      riskScore: customer.risk_score,
      memberSince: customer.created_at,
    },
    summary: {
      totalOrders: orders.length,
      totalSpent: Math.round(totalSpent * 100) / 100,
      refundCount,
      totalRefunded: Math.round(totalRefunded * 100) / 100,
      failedOrderCount,
      escalationCount,
    },
    orders: orders.map((o: any) => ({
      orderId: o.id,
      status: o.status,
      totalAmount: parseFloat(o.total_amount),
      date: o.created_at,
    })),
    recentActions: actions.slice(0, 10).map((a: any) => ({
      orderId: a.order_id,
      action: a.action,
      reason: a.reason,
      status: a.status,
      priority: a.priority,
      timestamp: a.created_at,
    })),
  };
}
