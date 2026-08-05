import mongoose from "mongoose";
import Offering from "./models/Offering.js";
import * as dotenv from "dotenv";
import {
  LIST_PRICES,
  OFFERING_IDENTIFIER,
  OFFERING_DESCRIPTION,
  annualDiscountPct,
} from "./config/pricing.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/shard";

/**
 * Seeds the display-fallback offering.
 *
 * Prices come from config/pricing.ts so this script can't drift from production —
 * it previously hardcoded a $79.99 yearly while production had been changed to
 * $50.00, so seeding a fresh database produced different prices than the live one.
 *
 * Use `sync-offerings.ts` to update an offering that already exists.
 */
async function seedOfferings() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB for seeding...");

  const existing = await Offering.findOne({ identifier: OFFERING_IDENTIFIER });
  if (existing) {
    console.log("Offerings already exist. Run sync-offerings.ts to update prices.");
    process.exit(0);
  }

  await Offering.create({
    identifier: OFFERING_IDENTIFIER,
    description: OFFERING_DESCRIPTION,
    packages: LIST_PRICES,
  });

  console.log(
    `✅ Offerings seeded: ${LIST_PRICES.map((p) => `${p.identifier} ${p.priceString}`).join(" · ")} ` +
      `(annual is ${annualDiscountPct()}% off monthly)`
  );
  process.exit(0);
}

seedOfferings().catch((err) => {
  console.error("❌ Seeding failed:", err);
  process.exit(1);
});
