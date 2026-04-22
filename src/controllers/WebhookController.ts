import { Request, Response } from "express";
import { User } from "../models/User.js";
import SubscriptionHistory from "../models/SubscriptionHistory.js";

export const handleRevenueCatWebhook = async (req: Request, res: Response) => {
  // Verify Webhook Secret (Bearer Token)
  const authHeader = req.headers.authorization;
  const storeKey = process.env.REVENUE_CAT_STORE_KEY;

  if (storeKey && authHeader !== `Bearer ${storeKey}`) {
    console.warn(`[REVENUECAT WEBHOOK] Unauthorized request attempt from ${req.ip}`);
    return res.status(401).send("Unauthorized");
  }

  const { event } = req.body;
  if (!event) return res.status(400).send("No event data");

  const { type, app_user_id, price_in_purchased_currency, currency, transaction_id } = event;

  console.log(`[REVENUECAT WEBHOOK] ${type} for user: ${app_user_id}`);

  try {
    const user = await User.findById(app_user_id);
    if (!user) return res.status(404).send("User not found");

    // Idempotency check: Deduplicate by transaction_id
    if (transaction_id) {
      const existing = await SubscriptionHistory.findOne({ paymentId: transaction_id });
      if (existing) {
        console.log(`[REVENUECAT WEBHOOK] Duplicate transaction detected: ${transaction_id}. Skipping.`);
        return res.status(200).send("OK (Duplicate)");
      }
    }

    let action: "PURCHASE" | "RENEWAL" | "CANCELLATION" | "EXPIRY" | "UPGRADE" = "PURCHASE";
    let tier: "free" | "pro" | "enterprise" = "pro";

    switch (type) {
      case "INITIAL_PURCHASE":
        action = "PURCHASE";
        tier = "pro";
        break;
      case "RENEWAL":
        action = "RENEWAL";
        tier = "pro";
        break;
      case "CANCELLATION":
        action = "CANCELLATION";
        // Do NOT change tier yet. User keeps access until expiration.
        tier = user.subscriptionTier as any || "pro"; 
        break;
      case "EXPIRATION":
        action = "EXPIRY";
        tier = "free";
        break;
      default:
        console.log(`[REVENUECAT WEBHOOK] Unhandled event type: ${type}`);
        return res.status(200).send("Event type not handled");
    }

    // Update user tier (only if it changed)
    if (user.subscriptionTier !== tier) {
      await User.findByIdAndUpdate(app_user_id, { subscriptionTier: tier });
    }

    // Log in history
    await SubscriptionHistory.create({
      userId: app_user_id,
      tier,
      action,
      amount: price_in_purchased_currency || 0,
      currency: currency || "USD",
      paymentId: transaction_id,
      timestamp: new Date(),
    });

    res.status(200).send("OK");
  } catch (error) {
    console.error("[REVENUECAT WEBHOOK ERROR]", error);
    res.status(500).send("Internal Server Error");
  }
};
