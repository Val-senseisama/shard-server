import mongoose from "mongoose";
import Offering from "./models/Offering.js";
import * as dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/shard";

async function updatePrices() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB...");

  const result = await Offering.updateOne(
    { identifier: "default", "packages.identifier": "monthly" },
    {
      $set: {
        "packages.$.price": 5.00,
        "packages.$.priceString": "$5.00"
      }
    }
  );

  if (result.modifiedCount > 0) {
    console.log("✅ Successfully updated monthly price to $5.00");
  } else {
    console.log("ℹ️ No changes made (price might already be $5.00 or offering not found)");
  }

  process.exit(0);
}

updatePrices().catch((err) => {
  console.error("❌ Update failed:", err);
  process.exit(1);
});
