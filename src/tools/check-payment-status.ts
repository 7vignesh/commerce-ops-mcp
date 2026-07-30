import { z } from "zod";
import { queryOne } from "../db/index.js";

export const checkPaymentStatusSchema = z.object({
  orderId: z.string().describe("The order ID to check payment status for (e.g. ORD-1001)"),
});

export type CheckPaymentStatusInput = z.infer<typeof checkPaymentStatusSchema>;

export async function checkPaymentStatus(input: CheckPaymentStatusInput): Promise<object> {
  const { orderId } = input;

  const payment = await queryOne(
    `SELECT p.*, o.status as order_status, o.total_amount
     FROM payments p JOIN orders o ON p.order_id = o.id
     WHERE p.order_id = $1`,
    [orderId]
  );

  if (!payment) {
    return { found: false, message: `No payment found for order ${orderId}` };
  }

  const result: any = {
    found: true,
    orderId,
    payment: {
      id: payment.id,
      method: payment.method,
      status: payment.status,
      amount: parseFloat(payment.amount),
    },
  };

  if (payment.status === "failed") {
    result.payment.failureReason = payment.failure_reason;
    result.suggestion = "Payment failed. Customer may need to retry payment or use a different method.";
  }

  if (payment.status === "refunded" || parseFloat(payment.refunded_amount) > 0) {
    result.payment.refundedAmount = parseFloat(payment.refunded_amount);
    result.payment.refundedAt = payment.refunded_at;
    result.payment.remainingAmount = parseFloat(payment.amount) - parseFloat(payment.refunded_amount);
  }

  if (payment.status === "pending") {
    result.suggestion = "Payment is still pending. It may take a few minutes for UPI/netbanking to confirm.";
  }

  return result;
}
