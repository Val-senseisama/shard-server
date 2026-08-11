import { Request, Response } from "express";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import SubscriptionHistory from "../models/SubscriptionHistory.js";
import { logError } from "../Helpers/Helpers.js";
import { FREE_MONTHLY_CREDITS, eventMatchesEntitlement } from "../Helpers/Entitlements.js";
import { logEvent } from "../Helpers/Telemetry.js";
import { cacheInvalidate } from "../Helpers/Cache.js";

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

  const { type, app_user_id, price_in_purchased_currency, currency, transaction_id, entitlement_ids, entitlement_id, expiration_at_ms } = event;

  // Validate app_user_id is a real MongoDB ObjectId before querying
  if (!app_user_id || !mongoose.isValidObjectId(app_user_id)) {
    logError("RevenueCatWebhook", "Invalid app_user_id", { severity: "medium", metadata: { app_user_id } });
    return res.status(400).send("Invalid user ID");
  }

  try {
    const user = await User.findById(app_user_id);
    if (!user) return res.status(404).send("User not found");

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

    // Idempotency: same transaction AND same event.
    //
    // This used to key on transaction_id alone, which silently broke every
    // downgrade. RevenueCat sends CANCELLATION and EXPIRATION carrying the SAME
    // transaction_id as the purchase or renewal they refer to, so once a
    // PURCHASE row existed, every later event for that transaction was
    // classified as a duplicate and dropped before it could run — meaning
    // EXPIRATION never fired and a cancelled subscriber kept Pro forever.
    //
    // One transaction legitimately produces PURCHASE → CANCELLATION → EXPIRY,
    // so the action has to be part of the key. A genuine redelivery still
    // matches on both fields and is still rejected.
    if (transaction_id) {
      const existing = await SubscriptionHistory.findOne({
        paymentId: transaction_id,
        action,
      });
      if (existing) return res.status(200).send("OK (Duplicate)");
    }

    // For grants (purchase/renewal), verify the event concerns OUR entitlement
    // before unlocking Pro — a purchase of some other product must not grant access.
    if ((action === "PURCHASE" || action === "RENEWAL") && tier !== "free") {
      if (!eventMatchesEntitlement(entitlement_ids, entitlement_id)) {
        logError("RevenueCatWebhook", "Entitlement id mismatch — not granting Pro", {
          severity: "medium",
          metadata: { app_user_id, entitlement_ids, entitlement_id },
        });
        return res.status(200).send("OK (entitlement not recognized)");
      }
    }

    // The renewal date has to be written even when the tier is unchanged — a
    // RENEWAL event on an already-Pro user is exactly when the date moves, and
    // that is the common case. Gating this on a tier change would leave the
    // date frozen at whatever the first purchase set.
    const userUpdate: Record<string, any> = {};

    if (user.subscriptionTier !== tier) {
      userUpdate.subscriptionTier = tier;
      // Reset credits to free-tier allowance when a sub expires back to free
      if (tier === "free") userUpdate.aiCredits = FREE_MONTHLY_CREDITS;
    }

    if (tier === "free") {
      // Nothing left to count down to once they're back on free.
      userUpdate.subscriptionExpiresAt = null;
    } else if (expiration_at_ms) {
      userUpdate.subscriptionExpiresAt = new Date(Number(expiration_at_ms));
    }

    if (Object.keys(userUpdate).length > 0) {
      await User.findByIdAndUpdate(app_user_id, userUpdate);
      // currentUser is cached for 30 minutes. Without this, someone who has just
      // paid keeps being told they're on the free tier — upgrade wall and all —
      // for up to half an hour after the money left their account.
      await cacheInvalidate.user(String(app_user_id));
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

    // Authoritative purchase signal for the revenue funnel (a new paid subscription).
    if (action === "PURCHASE") {
      logEvent({
        name: "subscription_activated",
        userId: String(app_user_id),
        tier,
        props: { amount: price_in_purchased_currency || 0, currency: currency || "USD" },
      });
    }

    res.status(200).send("OK");
  } catch (error) {
    logError("RevenueCatWebhook", error, { severity: "high" });
    res.status(500).send("Internal Server Error");
  }
};
