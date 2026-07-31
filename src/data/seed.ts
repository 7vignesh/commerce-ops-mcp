import "dotenv/config";
import { initializeDatabase, query, execute, transaction } from "../db/index.js";

// Deterministic synthetic data for reproducibility
const customers = [
  { id: "cust_001", name: "Priya Sharma", email: "priya.sharma@gmail.com", phone: "+919876543210", risk_score: 15 },
  { id: "cust_002", name: "Rahul Verma", email: "rahul.verma@yahoo.com", phone: "+919876543211", risk_score: 25 },
  { id: "cust_003", name: "Anita Desai", email: "anita.desai@outlook.com", phone: "+919876543212", risk_score: 10 },
  { id: "cust_004", name: "Vikram Patel", email: "vikram.patel@gmail.com", phone: "+919876543213", risk_score: 45 },
  { id: "cust_005", name: "Sneha Reddy", email: "sneha.reddy@gmail.com", phone: "+919876543214", risk_score: 5 },
  { id: "cust_006", name: "Arjun Nair", email: "arjun.nair@hotmail.com", phone: "+919876543215", risk_score: 72 }, // High risk
  { id: "cust_007", name: "Kavita Joshi", email: "kavita.joshi@gmail.com", phone: "+919876543216", risk_score: 30 },
  { id: "cust_008", name: "Deepak Kumar", email: "deepak.kumar@yahoo.com", phone: "+919876543217", risk_score: 55 },
  { id: "cust_009", name: "Meera Iyer", email: "meera.iyer@gmail.com", phone: "+919876543218", risk_score: 8 },
  { id: "cust_010", name: "Suresh Gupta", email: "suresh.gupta@outlook.com", phone: "+919876543219", risk_score: 40 },
  { id: "cust_011", name: "Pooja Singh", email: "pooja.singh@gmail.com", phone: "+919876543220", risk_score: 20 },
  { id: "cust_012", name: "Amit Tiwari", email: "amit.tiwari@yahoo.com", phone: "+919876543221", risk_score: 65 },
  { id: "cust_013", name: "Lakshmi Menon", email: "lakshmi.menon@gmail.com", phone: "+919876543222", risk_score: 12 },
  { id: "cust_014", name: "Rajesh Khanna", email: "rajesh.khanna@hotmail.com", phone: "+919876543223", risk_score: 78 }, // High risk
  { id: "cust_015", name: "Divya Pillai", email: "divya.pillai@gmail.com", phone: "+919876543224", risk_score: 18 },
  { id: "cust_016", name: "Manish Agarwal", email: "manish.agarwal@outlook.com", phone: "+919876543225", risk_score: 35 },
  { id: "cust_017", name: "Ritu Bansal", email: "ritu.bansal@gmail.com", phone: "+919876543226", risk_score: 22 },
  { id: "cust_018", name: "Sanjay Mishra", email: "sanjay.mishra@yahoo.com", phone: "+919876543227", risk_score: 50 },
  { id: "cust_019", name: "Nisha Chauhan", email: "nisha.chauhan@gmail.com", phone: "+919876543228", risk_score: 9 },
  { id: "cust_020", name: "Karthik Rao", email: "karthik.rao@hotmail.com", phone: "+919876543229", risk_score: 85 }, // High risk
];

const products = [
  { name: "Wireless Bluetooth Earbuds", price: 29.99 },
  { name: "Cotton T-Shirt (Blue)", price: 12.99 },
  { name: "Stainless Steel Water Bottle", price: 18.99 },
  { name: "Laptop Stand (Adjustable)", price: 49.99 },
  { name: "Organic Green Tea (100 bags)", price: 9.50 },
  { name: "Phone Case (Silicone)", price: 6.99 },
  { name: "USB-C Charging Cable (2m)", price: 7.99 },
  { name: "Notebook (A5, Ruled)", price: 4.99 },
  { name: "Running Shoes (Men)", price: 64.99 },
  { name: "Backpack (30L)", price: 39.99 },
  { name: "Yoga Mat (6mm)", price: 16.99 },
  { name: "Desk Lamp (LED)", price: 24.99 },
  { name: "Kitchen Knife Set", price: 44.99 },
  { name: "Bluetooth Speaker", price: 35.99 },
  { name: "Face Wash (200ml)", price: 7.49 },
];

const carriers = ["FedEx", "UPS", "USPS", "DHL", "OnTrac"];
const paymentMethods = ["upi", "card", "cod", "netbanking"] as const;
const failureReasons = [
  "Insufficient funds",
  "Card declined by bank",
  "UPI timeout",
  "Network error during payment",
  "Bank server unavailable",
];

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(Math.floor(Math.random() * 24), Math.floor(Math.random() * 60));
  return date.toISOString();
}

function randomItems(): { name: string; quantity: number; price: number }[] {
  const count = Math.floor(Math.random() * 3) + 1;
  const selected: { name: string; quantity: number; price: number }[] = [];
  const usedIndices = new Set<number>();
  for (let i = 0; i < count; i++) {
    let idx: number;
    do {
      idx = Math.floor(Math.random() * products.length);
    } while (usedIndices.has(idx));
    usedIndices.add(idx);
    const product = products[idx];
    selected.push({ name: product.name, quantity: Math.floor(Math.random() * 2) + 1, price: product.price });
  }
  return selected;
}

function generateTrackingNumber(carrier: string): string {
  const prefix = carrier.substring(0, 2).toUpperCase();
  return `${prefix}${Math.random().toString(36).substring(2, 14).toUpperCase()}`;
}

interface OrderSeed {
  id: string;
  customerId: string;
  status: string;
  daysAgo: number;
  // Pins the line items so a scenario can target an exact total. Used by the
  // demo orders that need to sit either side of the $150 refund cap.
  items?: { name: string; quantity: number; price: number }[];
}

// Orders designed to cover the missing-delivery workflow well
const orderSeeds: OrderSeed[] = [
  // Pending orders (5) — no shipment yet
  { id: "ORD-1001", customerId: "cust_001", status: "pending", daysAgo: 1 },
  { id: "ORD-1002", customerId: "cust_003", status: "pending", daysAgo: 0 },
  { id: "ORD-1003", customerId: "cust_007", status: "pending", daysAgo: 2 },
  { id: "ORD-1004", customerId: "cust_012", status: "pending", daysAgo: 1 },
  { id: "ORD-1005", customerId: "cust_018", status: "pending", daysAgo: 0 },

  // Confirmed (processing shipment) (5)
  { id: "ORD-1006", customerId: "cust_002", status: "confirmed", daysAgo: 3 },
  { id: "ORD-1007", customerId: "cust_004", status: "confirmed", daysAgo: 2 },
  { id: "ORD-1008", customerId: "cust_006", status: "confirmed", daysAgo: 4 },
  { id: "ORD-1009", customerId: "cust_009", status: "confirmed", daysAgo: 3 },
  { id: "ORD-1010", customerId: "cust_011", status: "confirmed", daysAgo: 2 },

  // Shipped — in transit (8)
  { id: "ORD-1011", customerId: "cust_001", status: "shipped", daysAgo: 5 },
  { id: "ORD-1012", customerId: "cust_002", status: "shipped", daysAgo: 7 },
  { id: "ORD-1013", customerId: "cust_005", status: "shipped", daysAgo: 4 },
  { id: "ORD-1014", customerId: "cust_008", status: "shipped", daysAgo: 6 },
  { id: "ORD-1015", customerId: "cust_010", status: "shipped", daysAgo: 5 },
  { id: "ORD-1016", customerId: "cust_013", status: "shipped", daysAgo: 3 },
  { id: "ORD-1017", customerId: "cust_015", status: "shipped", daysAgo: 6 },
  { id: "ORD-1018", customerId: "cust_017", status: "shipped", daysAgo: 4 },

  // Shipped — LOST (key scenario for missing-delivery workflow) (7)
  // Each of these isolates a single refund-eligibility outcome so the workflow
  // can be demonstrated one policy rule at a time.
  { id: "ORD-1019", customerId: "cust_001", status: "shipped", daysAgo: 10 },  // risk 15, 10d, $98.95 — fully eligible
  { id: "ORD-1020", customerId: "cust_005", status: "shipped", daysAgo: 8 },   // risk 5,  8d  — fully eligible
  { id: "ORD-1021", customerId: "cust_006", status: "shipped", daysAgo: 12 },  // risk 72 — fails risk only
  { id: "ORD-1022", customerId: "cust_014", status: "shipped", daysAgo: 9 },   // risk 78 — fails risk only
  { id: "ORD-1023", customerId: "cust_019", status: "shipped", daysAgo: 7 },   // risk 9,  7d  — fully eligible
  { id: "ORD-1024", customerId: "cust_013", status: "shipped", daysAgo: 35 },  // risk 12, 35d — fails age only
  // risk 18, 6d, $229.98 — fails the $150 cap only
  {
    id: "ORD-1051",
    customerId: "cust_015",
    status: "shipped",
    daysAgo: 6,
    items: [{ name: "Kitchen Knife Set", quantity: 2, price: 114.99 }],
  },

  // Shipped — RETURNED (2)
  { id: "ORD-1025", customerId: "cust_003", status: "shipped", daysAgo: 11 },
  { id: "ORD-1026", customerId: "cust_009", status: "shipped", daysAgo: 9 },

  // Delivered (12)
  { id: "ORD-1027", customerId: "cust_001", status: "delivered", daysAgo: 15 },
  { id: "ORD-1028", customerId: "cust_002", status: "delivered", daysAgo: 12 },
  { id: "ORD-1029", customerId: "cust_003", status: "delivered", daysAgo: 20 },
  { id: "ORD-1030", customerId: "cust_005", status: "delivered", daysAgo: 18 },
  { id: "ORD-1031", customerId: "cust_007", status: "delivered", daysAgo: 14 },
  { id: "ORD-1032", customerId: "cust_009", status: "delivered", daysAgo: 25 },
  { id: "ORD-1033", customerId: "cust_010", status: "delivered", daysAgo: 10 },
  { id: "ORD-1034", customerId: "cust_011", status: "delivered", daysAgo: 22 },
  { id: "ORD-1035", customerId: "cust_013", status: "delivered", daysAgo: 16 },
  { id: "ORD-1036", customerId: "cust_016", status: "delivered", daysAgo: 19 },
  { id: "ORD-1037", customerId: "cust_017", status: "delivered", daysAgo: 13 },
  { id: "ORD-1038", customerId: "cust_019", status: "delivered", daysAgo: 21 },

  // Cancelled (4)
  { id: "ORD-1039", customerId: "cust_004", status: "cancelled", daysAgo: 8 },
  { id: "ORD-1040", customerId: "cust_011", status: "cancelled", daysAgo: 12 },
  { id: "ORD-1041", customerId: "cust_015", status: "cancelled", daysAgo: 5 },
  { id: "ORD-1042", customerId: "cust_018", status: "cancelled", daysAgo: 14 },

  // Failed payment (4)
  { id: "ORD-1043", customerId: "cust_005", status: "failed", daysAgo: 2 },
  { id: "ORD-1044", customerId: "cust_009", status: "failed", daysAgo: 1 },
  { id: "ORD-1045", customerId: "cust_012", status: "failed", daysAgo: 3 },
  { id: "ORD-1046", customerId: "cust_014", status: "failed", daysAgo: 0 },

  // Extra delivered orders for customer history depth (4)
  { id: "ORD-1047", customerId: "cust_006", status: "delivered", daysAgo: 30 },
  { id: "ORD-1048", customerId: "cust_014", status: "delivered", daysAgo: 28 },
  { id: "ORD-1049", customerId: "cust_020", status: "delivered", daysAgo: 45 },
  { id: "ORD-1050", customerId: "cust_020", status: "delivered", daysAgo: 50 },
];

// Track which orders should have "lost" or "returned" shipments
const lostOrderIds = new Set(["ORD-1019", "ORD-1020", "ORD-1021", "ORD-1022", "ORD-1023", "ORD-1024", "ORD-1051"]);
const returnedOrderIds = new Set(["ORD-1025", "ORD-1026"]);

export async function seed(): Promise<void> {
  await initializeDatabase();

  await transaction(async (client) => {
    // Clear existing data
    await client.query("TRUNCATE action_log, shipments, payments, orders, customers CASCADE");

    // Insert customers
    for (const c of customers) {
      await client.query(
        "INSERT INTO customers (id, name, email, phone, risk_score, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [c.id, c.name, c.email, c.phone, c.risk_score, daysAgo(60)]
      );
    }

    // Insert orders, payments, shipments
    for (const orderSeed of orderSeeds) {
      const items = orderSeed.items ?? randomItems();
      const totalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const createdAt = daysAgo(orderSeed.daysAgo);
      const updatedAt = daysAgo(Math.max(0, orderSeed.daysAgo - 1));

      await client.query(
        "INSERT INTO orders (id, customer_id, items, total_amount, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [orderSeed.id, orderSeed.customerId, JSON.stringify(items), totalAmount.toFixed(2), orderSeed.status, createdAt, updatedAt]
      );

      // Payment
      const paymentMethod = paymentMethods[Math.floor(Math.random() * paymentMethods.length)];
      let paymentStatus: string;
      let failureReason: string | null = null;
      let refundedAmount = 0;
      let refundedAt: string | null = null;

      if (orderSeed.status === "failed") {
        paymentStatus = "failed";
        failureReason = failureReasons[Math.floor(Math.random() * failureReasons.length)];
      } else if (orderSeed.status === "cancelled") {
        paymentStatus = "refunded";
        refundedAmount = totalAmount;
        refundedAt = updatedAt;
      } else if (orderSeed.status === "pending") {
        paymentStatus = "pending";
      } else {
        paymentStatus = "success";
      }

      await client.query(
        "INSERT INTO payments (id, order_id, method, status, amount, failure_reason, refunded_amount, refunded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [
          `pay_${orderSeed.id.replace("ORD-", "")}`,
          orderSeed.id,
          paymentMethod,
          paymentStatus,
          totalAmount.toFixed(2),
          failureReason,
          refundedAmount.toFixed(2),
          refundedAt,
        ]
      );

      // Shipment (only for confirmed, shipped, delivered)
      if (["confirmed", "shipped", "delivered"].includes(orderSeed.status)) {
        const carrier = carriers[Math.floor(Math.random() * carriers.length)];
        const trackingNumber = generateTrackingNumber(carrier);

        let shipmentStatus: string;
        let actualDelivery: string | null = null;
        const estimatedDelivery = daysAgo(orderSeed.daysAgo - 5);

        if (orderSeed.status === "confirmed") {
          shipmentStatus = "processing";
        } else if (lostOrderIds.has(orderSeed.id)) {
          shipmentStatus = "lost";
        } else if (returnedOrderIds.has(orderSeed.id)) {
          shipmentStatus = "returned";
        } else if (orderSeed.status === "delivered") {
          shipmentStatus = "delivered";
          actualDelivery = daysAgo(orderSeed.daysAgo - 2);
        } else {
          // Regular shipped — in transit or out for delivery
          shipmentStatus = Math.random() < 0.3 ? "out_for_delivery" : "in_transit";
        }

        await client.query(
          "INSERT INTO shipments (id, order_id, carrier, tracking_number, status, estimated_delivery, actual_delivery, last_update) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [
            `ship_${orderSeed.id.replace("ORD-", "")}`,
            orderSeed.id,
            carrier,
            trackingNumber,
            shipmentStatus,
            estimatedDelivery,
            actualDelivery,
            daysAgo(Math.max(0, orderSeed.daysAgo - 1)),
          ]
        );
      }
    }
  });

  console.log("✅ Database seeded successfully!");
  console.log(`   - ${customers.length} customers`);
  console.log(`   - ${orderSeeds.length} orders`);
  console.log(`   - ${orderSeeds.length} payments`);
  console.log(`   - ${orderSeeds.filter((o) => ["confirmed", "shipped", "delivered"].includes(o.status)).length} shipments`);
  console.log(`   - ${lostOrderIds.size} lost shipments (missing-delivery scenarios)`);
  console.log(`   - ${returnedOrderIds.size} returned shipments`);

  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
