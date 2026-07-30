import { z } from "zod";
import { queryOne } from "../db/index.js";

export const checkShipmentStatusSchema = z.object({
  orderId: z.string().describe("The order ID to check shipment/delivery status for (e.g. ORD-1019)"),
});

export type CheckShipmentStatusInput = z.infer<typeof checkShipmentStatusSchema>;

export async function checkShipmentStatus(input: CheckShipmentStatusInput): Promise<object> {
  const { orderId } = input;

  const shipment = await queryOne(
    `SELECT s.*, o.status as order_status
     FROM shipments s JOIN orders o ON s.order_id = o.id
     WHERE s.order_id = $1`,
    [orderId]
  );

  if (!shipment) {
    const order = await queryOne("SELECT id, status FROM orders WHERE id = $1", [orderId]);
    if (!order) {
      return { found: false, message: `Order ${orderId} not found` };
    }
    return {
      found: true,
      orderId,
      hasShipment: false,
      orderStatus: order.status,
      message: `Order ${orderId} is in "${order.status}" state and has no shipment yet.`,
    };
  }

  const estimatedDate = new Date(shipment.estimated_delivery);
  const now = new Date();
  const isDelayed = estimatedDate < now && shipment.status !== "delivered";
  const hasCarrierException = shipment.status === "lost" || shipment.status === "returned";

  const result: any = {
    found: true,
    orderId,
    hasShipment: true,
    shipment: {
      id: shipment.id,
      carrier: shipment.carrier,
      trackingNumber: shipment.tracking_number,
      status: shipment.status,
      estimatedDelivery: shipment.estimated_delivery,
      actualDelivery: shipment.actual_delivery,
      lastUpdate: shipment.last_update,
      isDelayed,
      hasCarrierException,
    },
  };

  if (shipment.status === "lost") {
    result.suggestion = "Shipment is marked as LOST by the carrier. This is a verified carrier exception. The customer may be eligible for a refund — use issue_refund if all eligibility conditions are met, or escalate_to_human if not.";
  } else if (shipment.status === "returned") {
    result.suggestion = "Shipment was RETURNED by the carrier. This is a verified carrier exception. The customer may be eligible for a refund or reship — escalate for review.";
  } else if (isDelayed) {
    const delayDays = Math.ceil((now.getTime() - estimatedDate.getTime()) / (1000 * 60 * 60 * 24));
    result.suggestion = `Delivery is delayed by approximately ${delayDays} day(s). The shipment is still in transit — not yet a carrier exception. Monitor or inform the customer.`;
  }

  return result;
}
