import mongoose from "mongoose";
import Offering from "./models/Offering.js";
import * as dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/shard";

async function seedOfferings() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB for seeding...");

  const existing = await Offering.findOne({ identifier: "default" });
  if (existing) {
    console.log("Offerings already exist. Skipping seed.");
    process.exit(0);
  }

  await Offering.create({
    identifier: "default",
    description: "Main Thinkertech Offerings",
    packages: [
      {
        identifier: "monthly",
        priceString: "$9.99",
        price: 9.99,
        currencyCode: "USD",
      },
      {
        identifier: "yearly",
        priceString: "$79.99",
        price: 79.99,
        currencyCode: "USD",
      },
      {
        identifier: "lifetime",
        priceString: "$199.99",
        price: 199.99,
        currencyCode: "USD",
      },
    ],
  });

  console.log("✅ Offerings seeded successfully!");
  process.exit(0);
}

seedOfferings().catch((err) => {
  console.error("❌ Seeding failed:", err);
  process.exit(1);
});
