import { queryOne, transaction } from "../db/index.js";
import pg from "pg";

// Refund eligibility policy constants
const REFUND_MAX_AMOUNT = 150.00; // $150 max auto-refund
const REFUND_MAX_ORDER_AGE_DAYS = 30;
const REFUND_MAX_RISK_SCORE = 70;

export interface RefundEligibility {
  eligible: boolean;
  reasons: string[];
  requiresEscalation: boolean;
}

export async function checkRefundEligibility(
  orderId: string,
  requestedAmount: number
): Promise<RefundEligibility> {
  const reasons: string[] = [];

  // Fetch order with customer and payment info
  const order = await queryOne(
    `SELECT o.*, c.risk_score, p.amount as paid_amount, p.status as payment_status, 
            p.refunded_amount, s.status as shipment_status
     FROM orders o
     JOIN customers c ON o.customer_id = c.id
     JOIN payments p ON p.order_id = o.id
     LEFT JOIN shipments s ON s.order_id = o.id
     WHERE o.id = $1`,
    [orderId]
  );

  if (!order) {
    return { eligible: false, reasons: ["Order not found"], requiresEscalation: false };
  }

  // 1. Amount must be <= $150
  if (requestedAmount > REFUND_MAX_AMOUNT) {
    reasons.push(`Requested amount ($${requestedAmount}) exceeds maximum auto-refund limit ($${REFUND_MAX_AMOUNT})`);
  }

  // 2. Amount must not exceed paid amount
  const paidAmount = parseFloat(order.paid_amount);
  const alreadyRefunded = parseFloat(order.refunded_amount);
  const refundableAmount = paidAmount - alreadyRefunded;

  if (requestedAmount > refundableAmount) {
    reasons.push(`Requested amount ($${requestedAmount}) exceeds refundable amount ($${refundableAmount.toFixed(2)})`);
  }

  // 3. Order must be no more than 30 days old
  const orderDate = new Date(order.created_at);
  const now = new Date();
  const orderAgeDays = Math.ceil((now.getTime() - orderDate.getTime()) / (1000 * 60 * 60 * 24));

  if (orderAgeDays > REFUND_MAX_ORDER_AGE_DAYS) {
    reasons.push(`Order is ${orderAgeDays} days old (maximum ${REFUND_MAX_ORDER_AGE_DAYS} days for auto-refund)`);
  }

  // 4. Customer risk score must be below 70
  if (order.risk_score >= REFUND_MAX_RISK_SCORE) {
    reasons.push(`Customer risk score (${order.risk_score}) is at or above threshold (${REFUND_MAX_RISK_SCORE})`);
  }

  // 5. Carrier exception must be verified (shipment lost or returned)
  if (!order.shipment_status || !["lost", "returned"].includes(order.shipment_status)) {
    reasons.push(`No verified carrier exception — shipment status is "${order.shipment_status || "none"}"`);
  }

  // 6. No existing refund for this order
  if (alreadyRefunded > 0) {
    reasons.push(`Order already has a refund of $${alreadyRefunded.toFixed(2)}`);
  }

  // Check payment was successful
  if (order.payment_status !== "success") {
    reasons.push(`Payment status is "${order.payment_status}" — cannot refund a non-successful payment`);
  }

  const eligible = reasons.length === 0;
  return { eligible, reasons, requiresEscalation: !eligible };
}

export async function processRefund(
  client: pg.PoolClient,
  orderId: string,
  amount: number,
  reason: string,
  idempotencyKey: string
): Promise<{ success: boolean; message: string }> {
  // Check idempotency — if this key already exists, return existing result
  const existing = await client.query(
    "SELECT id, details FROM action_log WHERE idempotency_key = $1",
    [idempotencyKey]
  );

  if (existing.rows.length > 0) {
    return {
      success: true,
      message: `Refund already processed (idempotent). Action ID: ${existing.rows[0].id}`,
    };
  }

  // Update payment record atomically
  const updateResult = await client.query(
    `UPDATE payments 
     SET refunded_amount = refunded_amount + $1, 
         refunded_at = NOW(),
         status = CASE 
           WHEN refunded_amount + $1 >= amount THEN 'refunded'
           ELSE status
         END
     WHERE order_id = $2 
       AND status = 'success'
       AND refunded_amount + $1 <= amount
     RETURNING id`,
    [amount, orderId]
  );

  if (updateResult.rowCount === 0) {
    return { success: false, message: "Refund failed — payment state changed or amount exceeds paid amount" };
  }

  // Log the action
  const actionId = `act_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  await client.query(
    `INSERT INTO action_log (id, order_id, action, reason, details, idempotency_key, status, priority)
     VALUES ($1, $2, 'refund', $3, $4, $5, 'completed', 'medium')`,
    [
      actionId,
      orderId,
      reason,
      JSON.stringify({ amount, refundedAt: new Date().toISOString() }),
      idempotencyKey,
    ]
  );

  return { success: true, message: `Refund of $${amount.toFixed(2)} processed successfully. Action ID: ${actionId}` };
}

export async function createEscalation(
  client: pg.PoolClient,
  orderId: string,
  action: string,
  reason: string,
  priority: string,
  evidence: object,
  idempotencyKey: string
): Promise<{ success: boolean; escalationId: string; message: string }> {
  // Check idempotency
  const existing = await client.query(
    "SELECT id FROM action_log WHERE idempotency_key = $1",
    [idempotencyKey]
  );

  if (existing.rows.length > 0) {
    return {
      success: true,
      escalationId: existing.rows[0].id,
      message: `Escalation already exists (idempotent). ID: ${existing.rows[0].id}`,
    };
  }

  const escalationId = `esc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  await client.query(
    `INSERT INTO action_log (id, order_id, action, reason, details, idempotency_key, status, priority)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending_approval', $7)`,
    [escalationId, orderId, action, reason, JSON.stringify(evidence), idempotencyKey, priority]
  );

  return {
    success: true,
    escalationId,
    message: `Escalation created for manager approval. ID: ${escalationId}`,
  };
}
