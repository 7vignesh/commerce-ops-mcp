import { z } from "zod";
import { transaction, queryOne } from "../db/index.js";
import { checkRefundEligibility, processRefund, createEscalation } from "../guards/safety.js";

export const issueRefundSchema = z.object({
  orderId: z.string().describe("The order ID to issue a refund for (e.g. ORD-1019)"),
  amount: z.number().positive().describe("The refund amount in USD. Must be <= $150 for auto-approval."),
  reason: z.string().min(10).describe("Detailed reason for the refund (minimum 10 characters). Required for audit."),
});

export type IssueRefundInput = z.infer<typeof issueRefundSchema>;

export async function issueRefund(input: IssueRefundInput): Promise<object> {
  const { orderId, amount, reason } = input;

  // Generate idempotency key from order + amount + reason hash
  const idempotencyKey = `refund_${orderId}_${amount}_${Buffer.from(reason).toString("base64url").substring(0, 16)}`;

  // Replay check FIRST. A retry of a request we already completed must return
  // the original outcome, otherwise the eligibility check below would see the
  // refund we ourselves recorded and escalate a duplicate to a manager.
  const replay: any = await queryOne(
    "SELECT id, action FROM action_log WHERE idempotency_key = $1",
    [idempotencyKey]
  );

  if (replay) {
    return {
      refundProcessed: true,
      autoEscalated: false,
      idempotentReplay: true,
      amount,
      orderId,
      message: `Refund already processed (idempotent). Action ID: ${replay.id}`,
    };
  }

  // Check eligibility (all 6 conditions)
  const eligibility = await checkRefundEligibility(orderId, amount);

  if (!eligibility.eligible) {
    // Auto-escalate — create manager approval request
    const escalationResult = await transaction(async (client) => {
      return createEscalation(
        client,
        orderId,
        "refund_escalation",
        reason,
        "high",
        {
          requestedAmount: amount,
          failedConditions: eligibility.reasons,
          originalAction: "issue_refund",
        },
        `esc_refund_${orderId}_${amount}`
      );
    });

    return {
      refundProcessed: false,
      autoEscalated: true,
      escalationId: escalationResult.escalationId,
      failedConditions: eligibility.reasons,
      message: `Refund of $${amount.toFixed(2)} does not meet auto-approval criteria. Escalated for manager review.`,
    };
  }

  // All conditions passed — process the refund atomically
  const result = await transaction(async (client) => {
    return processRefund(client, orderId, amount, reason, idempotencyKey);
  });

  return {
    refundProcessed: result.success,
    autoEscalated: false,
    amount,
    orderId,
    message: result.message,
  };
}
