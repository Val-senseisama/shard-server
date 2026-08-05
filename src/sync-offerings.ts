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
 * Bring the stored display-fallback offering in line with config/pricing.ts,
 * adding new plans and removing retired ones.
 *
 * Replaces `force-update-offerings.ts`, which hardcoded a single price for a
 * single plan and had to be edited every time — which is how the seed and
 * production drifted apart in the first place.
 *
 * REMINDER: this only changes what the app *displays* when the store SDK is
 * unreachable. Real charges come from Play Console / App Store Connect via
 * RevenueCat and must be changed there too.
 *
 * Dry-run by default. Pass `--commit` to write.
 */
async function syncOfferings() {
  const commit = process.argv.includes("--commit");

  await mongoose.connect(MONGO_URI);
  console.log(`Connected to MongoDB${commit ? "" : " (DRY RUN — pass --commit to write)"}\n`);

  const existing = await Offering.findOne({ identifier: OFFERING_IDENTIFIER }).lean();

  if (!existing) {
    console.log("No offering found. Run seed-offerings.ts first.");
    process.exit(0);
  }

  const before = new Map<string, any>(
    ((existing as any).packages ?? []).map((p: any) => [p.identifier as string, p])
  );
  const after = new Map<string, (typeof LIST_PRICES)[number]>(
    LIST_PRICES.map((p) => [p.identifier as string, p])
  );

  for (const [id, want] of after) {
    const have = before.get(id);
    if (!have) {
      console.log(`  + ${id}: (new) → ${want.priceString}`);
    } else if (have.price !== want.price || have.priceString !== want.priceString) {
      console.log(`  ~ ${id}: ${have.priceString} → ${want.priceString}`);
    } else {
      console.log(`  = ${id}: ${want.priceString} (unchanged)`);
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      console.log(`  - ${id}: ${before.get(id).priceString} → REMOVED`);
    }
  }

  console.log(`\nAnnual is ${annualDiscountPct()}% off paying monthly.`);

  if (!commit) {
    console.log("\nDry run — nothing written.");
    process.exit(0);
  }

  await Offering.updateOne(
    { identifier: OFFERING_IDENTIFIER },
    { $set: { description: OFFERING_DESCRIPTION, packages: LIST_PRICES } }
  );

  const verify = await Offering.findOne({ identifier: OFFERING_IDENTIFIER }).lean();
  console.log(
    "\n✅ Written. Now stored:",
    ((verify as any).packages ?? [])
      .map((p: any) => `${p.identifier} ${p.priceString}`)
      .join(" · ")
  );
  console.log(
    "\n⚠️  Set the same prices in Play Console / App Store Connect and RevenueCat —\n" +
      "   this only changed the offline display fallback, not what anyone is charged."
  );
  process.exit(0);
}

syncOfferings().catch((err) => {
  console.error("❌ Sync failed:", err);
  process.exit(1);
});
