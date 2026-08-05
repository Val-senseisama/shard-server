/**
 * Shard Pro list prices — the single place they're written down.
 *
 * IMPORTANT: these are **display fallbacks only**. The amount a user is actually
 * charged is configured in Google Play / App Store Connect and served through
 * RevenueCat, and the paywall renders RevenueCat's localised `priceString`
 * (see shard/app/(screens)/subscribe-pro.tsx). These values are used only when
 * the store SDK can't be reached, and the UI labels them as approximate.
 *
 * So changing this file does NOT change what anyone pays. If you change a price
 * here, change it in Play Console / App Store Connect and RevenueCat too, or the
 * offline fallback will quietly disagree with reality.
 *
 * The previous state was exactly that kind of drift: the seed script said the
 * yearly plan was $79.99 while production said $50.00.
 *
 * ── Why these numbers (decided 2026-07-27) ──
 *
 * Monthly is deliberately a "convenience tax". What matters isn't the absolute
 * price but the SPREAD: yearly works out to ~$4.58/month, which is *cheaper than
 * the old $5 monthly*, so the committed buyer pays less than before and only the
 * uncommitted one pays for optionality. The old $50-vs-$60 spread was a 17%
 * discount — nobody commits a year to save eight dollars, so everyone took
 * monthly, which is worse for both churn and cash.
 *
 * $5/month also contradicted the positioning: the AI-planning category prices at
 * $8–30/month, and selling "AI builds your plan and someone holds you to it" for
 * five dollars signals a toy rather than a tool.
 *
 * Lifetime ($199.99) was removed rather than repriced — see SUPPORTED_PLANS in
 * the paywall for why.
 */

export interface ListPrice {
  identifier: "monthly" | "yearly";
  price: number;
  priceString: string;
  currencyCode: string;
}

export const LIST_PRICES: ListPrice[] = [
  { identifier: "monthly", price: 8.99, priceString: "$8.99", currencyCode: "USD" },
  { identifier: "yearly", price: 54.99, priceString: "$54.99", currencyCode: "USD" },
];

export const OFFERING_IDENTIFIER = "default";
export const OFFERING_DESCRIPTION = "Shard Pro";

/** Annual discount against paying monthly for a year, as a percentage. */
export function annualDiscountPct(prices: ListPrice[] = LIST_PRICES): number {
  const m = prices.find((p) => p.identifier === "monthly")?.price;
  const y = prices.find((p) => p.identifier === "yearly")?.price;
  if (!m || !y) return 0;
  return Math.round((1 - y / (m * 12)) * 100);
}
