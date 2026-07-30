import { z } from "zod";
import { query } from "../db/index.js";

export const lookupOrderSchema = z.object({
  query: z.string().describe("Order ID (e.g. ORD-1001), customer email, or phone number to search for"),
});

export type LookupOrderInput = z.infer<typeof lookupOrderSchema>;

export async function lookupOrder(input: LookupOrderInput): Promise<object> {
  const { query: searchQuery } = input;
  const trimmed = searchQuery.trim();

  let rows: any[];

  if (trimmed.toUpperCase().startsWith("ORD-")) {
    rows = await query(
      `SELECT o.id as order_id, o.status, o.total_amount, o.created_at, c.name as customer_name, c.email
       FROM orders o JOIN customers c ON o.customer_id = c.id
       WHERE o.id = $1`,
      [trimmed.toUpperCase()]
    );
  } else if (trimmed.includes("@")) {
    rows = await query(
      `SELECT o.id as order_id, o.status, o.total_amount, o.created_at, c.name as customer_name, c.email
       FROM orders o JOIN customers c ON o.customer_id = c.id
       WHERE c.email = $1
       ORDER BY o.created_at DESC`,
      [trimmed.toLowerCase()]
    );
  } else if (trimmed.startsWith("+") || /^\d{10,}$/.test(trimmed)) {
    const phone = trimmed.startsWith("+") ? trimmed : `+91${trimmed}`;
    rows = await query(
      `SELECT o.id as order_id, o.status, o.total_amount, o.created_at, c.name as customer_name, c.email
       FROM orders o JOIN customers c ON o.customer_id = c.id
       WHERE c.phone = $1
       ORDER BY o.created_at DESC`,
      [phone]
    );
  } else {
    rows = await query(
      `SELECT o.id as order_id, o.status, o.total_amount, o.created_at, c.name as customer_name, c.email
       FROM orders o JOIN customers c ON o.customer_id = c.id
       WHERE o.id = $1
       ORDER BY o.created_at DESC`,
      [trimmed]
    );
  }

  if (rows.length === 0) {
    return { found: false, message: `No orders found for query: "${searchQuery}"` };
  }

  return {
    found: true,
    count: rows.length,
    orders: rows.map((r: any) => ({
      orderId: r.order_id,
      status: r.status,
      totalAmount: parseFloat(r.total_amount),
      date: r.created_at,
      customerName: r.customer_name,
      customerEmail: r.email,
    })),
  };
}
