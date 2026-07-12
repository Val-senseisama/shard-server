import { randomBytes } from "crypto";
import { User } from "../models/User.js";
import { logEvent } from "./Telemetry.js";

/** Bonus AI credits granted to BOTH the referrer and the new user on a successful referral. */
export const REFERRAL_BONUS_CREDITS = 10;

// Unambiguous alphabet (no 0/O/1/I) for codes that get typed by hand.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 7;

function randomCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Generate a referral code that isn't already taken (retries on the rare collision). */
export async function generateReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const clash = await User.exists({ referralCode: code });
    if (!clash) return code;
  }
  // Extremely unlikely; fall back to a longer code.
  return randomCode() + randomCode().slice(0, 3);
}

/**
 * Apply a referral for a newly-created user. Idempotent per new user (only ever
 * called once at signup). Grants bonus credits to both sides and returns the
 * referrer's id, or null if the code was invalid / self-referral.
 */
export async function applyReferral(newUserId: string, code?: string | null): Promise<string | null> {
  if (!code) return null;
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;

  const referrer = await User.findOne({ referralCode: normalized }, "_id").lean();
  if (!referrer) return null;
  const referrerId = referrer._id.toString();
  if (referrerId === newUserId) return null; // can't refer yourself

  await Promise.all([
    User.findByIdAndUpdate(newUserId, {
      referredBy: referrerId,
      $inc: { aiCredits: REFERRAL_BONUS_CREDITS },
    }),
    User.findByIdAndUpdate(referrerId, {
      $inc: { aiCredits: REFERRAL_BONUS_CREDITS, referralCount: 1 },
    }),
  ]);

  logEvent({ name: "referral_completed", userId: referrerId, props: { newUserId, bonus: REFERRAL_BONUS_CREDITS } });
  return referrerId;
}
