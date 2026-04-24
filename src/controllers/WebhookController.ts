import { Request, Response } from "express";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import SubscriptionHistory from "../models/SubscriptionHistory.js";
import { logError } from "../Helpers/Helpers.js";

export const handleRevenueCatWebhook = async (req: Request, res: Response) => {
  // Fail CLOSED — if the secret is missing from env, reject all requests
  const storeKey = process.env.REVENUE_CAT_STORE_KEY;
  const authHeader = req.headers.authorization;

  if (!storeKey || authHeader !== `Bearer ${storeKey}`) {
    logError("RevenueCatWebhook", "Unauthorized request", { severity: "high", metadata: { ip: req.ip } });
    return res.status(401).send("Unauthorized");
  }

  const { event } = req.body;
  if (!event) return res.status(400).send("No event data");

  const { type, app_user_id, price_in_purchased_currency, currency, transaction_id } = event;

  // Validate app_user_id is a real MongoDB ObjectId before querying
  if (!app_user_id || !mongoose.isValidObjectId(app_user_id)) {
    logError("RevenueCatWebhook", "Invalid app_user_id", { severity: "medium", metadata: { app_user_id } });
    return res.status(400).send("Invalid user ID");
  }

  try {
    const user = await User.findById(app_user_id);
    if (!user) return res.status(404).send("User not found");

    // Idempotency: deduplicate by transaction_id
    if (transaction_id) {
      const existing = await SubscriptionHistory.findOne({ paymentId: transaction_id });
      if (existing) return res.status(200).send("OK (Duplicate)");
    }

    let action: "PURCHASE" | "RENEWAL" | "CANCELLATION" | "EXPIRY" | "UPGRADE" = "PURCHASE";
    let tier: "free" | "pro" | "enterprise" = "pro";

    switch (type) {
      case "INITIAL_PURCHASE":
        action = "PURCHASE"; tier = "pro"; break;
      case "RENEWAL":
        action = "RENEWAL"; tier = "pro"; break;
      case "CANCELLATION":
        action = "CANCELLATION";
        tier = user.subscriptionTier as any || "pro";
        break;
      case "EXPIRATION":
        action = "EXPIRY"; tier = "free"; break;
      default:
        return res.status(200).send("Event type not handled");
    }

    if (user.subscriptionTier !== tier) {
      await User.findByIdAndUpdate(app_user_id, { subscriptionTier: tier });
    }

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
    logError("RevenueCatWebhook", error, { severity: "high" });
    res.status(500).send("Internal Server Error");
  }
};
