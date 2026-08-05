import dotenv from "dotenv";
// Load .env.test if present (local isolated Postgres), fall back to .env
dotenv.config({ path: ".env.test" });
dotenv.config();
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import pool, { initializeDatabase, query, queryOne, transaction } from "../src/db/index.js";
import { issueRefund } from "../src/tools/issue-refund.js";
import { cancelOrder } from "../src/tools/cancel-order.js";
import { reshipOrder } from "../src/tools/reship-order.js";
import { escalateToHuman } from "../src/tools/escalate-to-human.js";

/**
 * PostgreSQL-backed verification of safety and idempotency behavior.
 *
 * These tests write to the real database, so each test seeds its own
 * fixtures with a unique prefix and cleans up afterwards. This keeps
 * them independent of the demo seed data.
 */

const PREFIX = "TEST";
let counter = 0;

function nextId(): string {
  counter += 1;
  return `${PREFIX}-${Date.now().toString(36)}-${counter}`;
}

interface FixtureOptions {
  riskScore?: number;
  orderAgeDays?: number;
  amount?: number;
  paymentStatus?: "success" | "failed" | "pending" | "refunded";
  refundedAmount?: number;
  shipmentStatus?: "processing" | "in_transit" | "out_for_delivery" | "delivered" | "lost" | "returned" | null;
  orderStatus?: "pending" | "confirmed" | "shipped" | "delivered" | "cancelled" | "failed";
}

interface Fixture {
  orderId: string;
  customerId: string;
}

const createdCustomers: string[] = [];
const createdOrders: string[] = [];

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const {
    riskScore = 10,
    orderAgeDays = 5,
    amount = 100,
    paymentStatus = "success",
    refundedAmount = 0,
    shipmentStatus = "lost",
    orderStatus = "shipped",
  } = options;

  const suffix = nextId();
  const customerId = `cust_${suffix}`;
  const orderId = `ORD-${suffix}`;

  const createdAt = new Date();
  createdAt.setDate(createdAt.getDate() - orderAgeDays);

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO customers (id, name, email, phone, risk_score, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [customerId, `Test ${suffix}`, `${customerId}@example.test`, `+1${Date.now()}${counter}`, riskScore]
    );

    await client.query(
      `INSERT INTO orders (id, customer_id, items, total_amount, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [
        orderId,
        customerId,
        JSON.stringify([{ name: "Test Product", quantity: 1, price: amount }]),
        amount.toFixed(2),
        orderStatus,
        createdAt.toISOString(),
      ]
    );

    await client.query(
      `INSERT INTO payments (id, order_id, method, status, amount, refunded_amount)
       VALUES ($1, $2, 'card', $3, $4, $5)`,
      [`pay_${suffix}`, orderId, paymentStatus, amount.toFixed(2), refundedAmount.toFixed(2)]
    );

    if (shipmentStatus) {
      const estimated = new Date(createdAt);
      estimated.setDate(estimated.getDate() + 3);
      await client.query(
        `INSERT INTO shipments (id, order_id, carrier, tracking_number, status, estimated_delivery, last_update)
         VALUES ($1, $2, 'FedEx', $3, $4, $5, NOW())`,
        [`ship_${suffix}`, orderId, `TRK${suffix}`, shipmentStatus, estimated.toISOString()]
      );
    }
  });

  createdCustomers.push(customerId);
  createdOrders.push(orderId);

  return { orderId, customerId };
}

async function getPayment(orderId: string) {
  return queryOne("SELECT * FROM payments WHERE order_id = $1", [orderId]);
}

async function getActions(orderId: string) {
  return query("SELECT * FROM action_log WHERE order_id = $1 ORDER BY created_at ASC", [orderId]);
}

beforeAll(async () => {
  await initializeDatabase();
});

afterAll(async () => {
  // Clean up every row this suite created
  if (createdOrders.length > 0) {
    await query("DELETE FROM action_log WHERE order_id = ANY($1)", [createdOrders]);
    await query("DELETE FROM shipments WHERE order_id = ANY($1)", [createdOrders]);
    await query("DELETE FROM payments WHERE order_id = ANY($1)", [createdOrders]);
    await query("DELETE FROM orders WHERE id = ANY($1)", [createdOrders]);
  }
  if (createdCustomers.length > 0) {
    await query("DELETE FROM customers WHERE id = ANY($1)", [createdCustomers]);
  }
  await pool.end();
});

describe("issue_refund — eligible path", () => {
  it("processes a refund when all six conditions pass", async () => {
    const { orderId } = await createFixture({ amount: 100, riskScore: 10, orderAgeDays: 5, shipmentStatus: "lost" });

    const result: any = await issueRefund({
      orderId,
      amount: 100,
      reason: "Carrier confirmed the parcel is lost; refunding the customer.",
    });

    expect(result.refundProcessed).toBe(true);
    expect(result.autoEscalated).toBe(false);

    const payment: any = await getPayment(orderId);
    expect(parseFloat(payment.refunded_amount)).toBe(100);
    expect(payment.status).toBe("refunded");

    const actions = await getActions(orderId);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("refund");
    expect(actions[0].status).toBe("completed");
  });

  it("accepts a partial refund and leaves the payment refundable", async () => {
    const { orderId } = await createFixture({ amount: 100 });

    const result: any = await issueRefund({
      orderId,
      amount: 40,
      reason: "Partial refund agreed with the customer for the lost item.",
    });

    expect(result.refundProcessed).toBe(true);

    const payment: any = await getPayment(orderId);
    expect(parseFloat(payment.refunded_amount)).toBe(40);
    expect(payment.status).toBe("success");
  });
});

describe("issue_refund — guardrails force escalation", () => {
  it("escalates when the amount exceeds the $150 cap", async () => {
    const { orderId } = await createFixture({ amount: 500 });

    const result: any = await issueRefund({
      orderId,
      amount: 200,
      reason: "Customer requested a refund above the automatic approval cap.",
    });

    expect(result.refundProcessed).toBe(false);
    expect(result.autoEscalated).toBe(true);
    expect(result.failedConditions.some((r: string) => r.includes("maximum auto-refund limit"))).toBe(true);

    const payment: any = await getPayment(orderId);
    expect(parseFloat(payment.refunded_amount)).toBe(0);
  });

  it("escalates when the amount exceeds the paid amount", async () => {
    const { orderId } = await createFixture({ amount: 50 });

    const result: any = await issueRefund({
      orderId,
      amount: 120,
      reason: "Requested refund is larger than what the customer actually paid.",
    });

    expect(result.refundProcessed).toBe(false);
    expect(result.failedConditions.some((r: string) => r.includes("exceeds refundable amount"))).toBe(true);
  });

  it("escalates when the order is older than 30 days", async () => {
    const { orderId } = await createFixture({ orderAgeDays: 45 });

    const result: any = await issueRefund({
      orderId,
      amount: 100,
      reason: "Customer reported a missing delivery on an older order.",
    });

    expect(result.refundProcessed).toBe(false);
    expect(result.failedConditions.some((r: string) => r.includes("days old"))).toBe(true);
  });

  it("escalates when the customer risk score is at or above 70", async () => {
    const { orderId } = await createFixture({ riskScore: 70 });

    const result: any = await issueRefund({
      orderId,
      amount: 100,
      reason: "Missing delivery reported by a customer flagged as higher risk.",
    });

    expect(result.refundProcessed).toBe(false);
    expect(result.failedConditions.some((r: string) => r.includes("risk score"))).toBe(true);
  });

  it("escalates when no carrier exception is verified", async () => {
    const { orderId } = await createFixture({ shipmentStatus: "in_transit" });

    const result: any = await issueRefund({
      orderId,
      amount: 100,
      reason: "Customer says the parcel has not arrived while it is still in transit.",
    });

    expect(result.refundProcessed).toBe(false);
    expect(result.failedConditions.some((r: string) => r.includes("carrier exception"))).toBe(true);
  });

  it("escalates when the order has no shipment at all", async () => {
    const { orderId } = await createFixture({ shipmentStatus: null, orderStatus: "pending" });

    const result: any = await issueRefund({
      orderId,
      amount: 100,
      reason: "Customer reported a missing delivery for an order not yet shipped.",
    });

    expect(result.refundProcessed).toBe(false);
    expect(result.failedConditions.some((r: string) => r.includes("carrier exception"))).toBe(true);
  });

  it("escalates when a refund already exists for the order", async () => {
    const { orderId } = await createFixture({ amount: 100, refundedAmount: 100, paymentStatus: "refunded" });

    const result: any = await issueRefund({
      orderId,
      amount: 100,
      reason: "Second refund attempt on an order that was already refunded.",
    });

    expect(result.refundProcessed).toBe(false);
    expect(result.failedConditions.some((r: string) => r.includes("already has a refund"))).toBe(true);
  });

  it("escalates when the payment never succeeded", async () => {
    const { orderId } = await createFixture({ paymentStatus: "failed", orderStatus: "failed" });

    const result: any = await issueRefund({
      orderId,
      amount: 100,
      reason: "Refund requested on an order whose payment failed at checkout.",
    });

    expect(result.refundProcessed).toBe(false);
    expect(result.failedConditions.some((r: string) => r.includes("non-successful payment"))).toBe(true);
  });

  it("records the escalation with the failed conditions as evidence", async () => {
    const { orderId } = await createFixture({ riskScore: 90 });

    const result: any = await issueRefund({
      orderId,
      amount: 100,
      reason: "High-risk customer reported a missing delivery.",
    });

    const actions = await getActions(orderId);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("refund_escalation");
    expect(actions[0].status).toBe("pending_approval");
    expect(actions[0].priority).toBe("high");
    expect(actions[0].details.failedConditions.length).toBeGreaterThan(0);
    expect(result.escalationId).toBe(actions[0].id);
  });
});

describe("issue_refund — idempotency", () => {
  it("does not double-refund when the same request is replayed", async () => {
    const { orderId } = await createFixture({ amount: 100 });
    const request = {
      orderId,
      amount: 50,
      reason: "Carrier confirmed the parcel is lost; issuing a partial refund.",
    };

    const first: any = await issueRefund(request);
    expect(first.refundProcessed).toBe(true);

    const second: any = await issueRefund(request);
    expect(second.refundProcessed).toBe(true);
    expect(second.message).toContain("idempotent");

    const payment: any = await getPayment(orderId);
    expect(parseFloat(payment.refunded_amount)).toBe(50);

    const actions = await getActions(orderId);
    expect(actions.filter((a: any) => a.action === "refund")).toHaveLength(1);
  });

  it("stays consistent when identical requests are fired concurrently", async () => {
    const { orderId } = await createFixture({ amount: 100 });
    const request = {
      orderId,
      amount: 60,
      reason: "Concurrent retry of the same lost-parcel refund request.",
    };

    const results = await Promise.allSettled([issueRefund(request), issueRefund(request)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThan(0);

    const payment: any = await getPayment(orderId);
    expect(parseFloat(payment.refunded_amount)).toBe(60);

    const actions = await getActions(orderId);
    expect(actions.filter((a: any) => a.action === "refund")).toHaveLength(1);
  });

  it("reuses the same escalation for a replayed ineligible request", async () => {
    const { orderId } = await createFixture({ riskScore: 85 });
    const request = {
      orderId,
      amount: 100,
      reason: "Replayed refund request for a high-risk customer.",
    };

    const first: any = await issueRefund(request);
    const second: any = await issueRefund(request);

    expect(first.escalationId).toBe(second.escalationId);

    const actions = await getActions(orderId);
    expect(actions).toHaveLength(1);
  });
});

describe("cancel_order — escalation only", () => {
  it("never cancels the order and always creates an escalation", async () => {
    const { orderId } = await createFixture({ orderStatus: "shipped", shipmentStatus: "in_transit" });

    const result: any = await cancelOrder({
      orderId,
      reason: "Customer asked to cancel the order after it had already shipped.",
    });

    expect(result.cancelProcessed).toBe(false);
    expect(result.escalated).toBe(true);
    expect(result.priority).toBe("high");

    const order: any = await queryOne("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(order.status).toBe("shipped");

    const actions = await getActions(orderId);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("cancel_request");
    expect(actions[0].status).toBe("pending_approval");
  });

  it("raises the priority to critical for a delivered order", async () => {
    const { orderId } = await createFixture({ orderStatus: "delivered", shipmentStatus: "delivered" });

    const result: any = await cancelOrder({
      orderId,
      reason: "Customer asked to cancel an order that has already been delivered.",
    });

    expect(result.escalated).toBe(true);
    expect(result.priority).toBe("critical");
  });

  it("reports an already-cancelled order without creating an escalation", async () => {
    const { orderId } = await createFixture({ orderStatus: "cancelled", shipmentStatus: null, paymentStatus: "refunded" });

    const result: any = await cancelOrder({
      orderId,
      reason: "Duplicate cancellation request for an order already cancelled.",
    });

    expect(result.alreadyCancelled).toBe(true);
    expect(await getActions(orderId)).toHaveLength(0);
  });

  it("returns not found for an unknown order", async () => {
    const result: any = await cancelOrder({
      orderId: "ORD-DOES-NOT-EXIST",
      reason: "Cancellation request for an order id that does not exist.",
    });

    expect(result.found).toBe(false);
  });
});

describe("reship_order — escalation only", () => {
  it("never reships and always creates an escalation for a lost parcel", async () => {
    const { orderId } = await createFixture({ shipmentStatus: "lost" });

    const result: any = await reshipOrder({
      orderId,
      reason: "Customer prefers a replacement instead of a refund for the lost parcel.",
    });

    expect(result.reshipProcessed).toBe(false);
    expect(result.escalated).toBe(true);
    expect(result.priority).toBe("high");

    const shipments = await query("SELECT * FROM shipments WHERE order_id = $1", [orderId]);
    expect(shipments).toHaveLength(1);

    const actions = await getActions(orderId);
    expect(actions[0].action).toBe("reship_request");
    expect(actions[0].status).toBe("pending_approval");
  });

  it("refuses to escalate when the parcel is still moving", async () => {
    const { orderId } = await createFixture({ shipmentStatus: "in_transit" });

    const result: any = await reshipOrder({
      orderId,
      reason: "Customer asked for a replacement while the parcel is still in transit.",
    });

    expect(result.canReship).toBe(false);
    expect(await getActions(orderId)).toHaveLength(0);
  });
});

describe("escalate_to_human", () => {
  it("stores priority, reason, and evidence durably", async () => {
    const { orderId } = await createFixture();

    const result: any = await escalateToHuman({
      orderId,
      reason: "Customer disputes the carrier proof of delivery and needs manual review.",
      priority: "critical",
      evidence: {
        shipmentStatus: "delivered",
        additionalContext: "Customer insists the parcel never arrived.",
      },
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("pending_approval");
    expect(result.sla).toBe("Immediate");

    const actions = await getActions(orderId);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("escalate");
    expect(actions[0].priority).toBe("critical");
    expect(actions[0].details.additionalContext).toContain("never arrived");
  });

  it("returns not found for an unknown order", async () => {
    const result: any = await escalateToHuman({
      orderId: "ORD-DOES-NOT-EXIST",
      reason: "Escalation for an order id that does not exist in the system.",
      priority: "low",
      evidence: {},
    });

    expect(result.found).toBe(false);
  });
});
