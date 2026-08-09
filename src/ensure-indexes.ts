/**
 * Build the indexes declared on the models.
 *
 * `config/db.ts` connects with `autoIndex: false`, which is the right setting for
 * production — you do not want a process building indexes on boot against a live
 * collection. The consequence is that an index declared in a model does nothing
 * until something creates it, so adding `schema.index(...)` and deploying is a
 * no-op. This script is that something.
 *
 * Run after any deploy that changes an index declaration:
 *
 *     npm run ensure:indexes
 *
 * `syncIndexes()` creates what is missing AND DROPS what the schema no longer
 * declares. That is required here — a TTL cannot be added to an existing
 * `{ createdAt: 1 }` index in place, so the old one has to go — but it does mean
 * any index created by hand in Atlas and not mirrored in a model will be removed.
 * Check the dry-run output before running this against production.
 *
 * Pass --dry-run to print the diff without touching anything.
 */
import "dotenv/config";
import mongoose from "mongoose";

import { User } from "./models/User.js";
import Shard from "./models/Shard.js";
import MiniGoal from "./models/MiniGoal.js";
import Chat, { Message } from "./models/Chat.js";
import Friendship from "./models/Friendship.js";
import Notification from "./models/Notifications.js";
import NotificationPreferences from "./models/NotificationPreferences.js";
import SideQuest from "./models/SideQuest.js";
import Challenge from "./models/Challenge.js";
import Team from "./models/Team.js";
import Report from "./models/Report.js";
import SupportFlag from "./models/SupportFlag.js";
import AuditTrail from "./models/AuditTrail.js";
import ErrorLog from "./models/ErrorLog.js";
import AnalyticsEvent from "./models/AnalyticsEvent.js";
import Analytics from "./models/Analytics.js";
import Achievement from "./models/Achievement.js";
import Subscription from "./models/Subscription.js";
import SubscriptionHistory from "./models/SubscriptionHistory.js";
import Offering from "./models/Offering.js";
import EmailQueue from "./models/EmailQueue.js";
import SocialShare from "./models/SocialShare.js";

const MODELS: mongoose.Model<any>[] = [
  User, Shard, MiniGoal, Chat, Message, Friendship,
  Notification, NotificationPreferences, SideQuest, Challenge, Team,
  Report, SupportFlag, AuditTrail, ErrorLog, AnalyticsEvent, Analytics,
  Achievement, Subscription, SubscriptionHistory, Offering, EmailQueue,
  SocialShare,
];

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set.");
    process.exit(1);
  }

  // autoIndex stays off here too — this script creates indexes explicitly.
  await mongoose.connect(uri, { autoIndex: false });
  console.log(`✅ Connected${dryRun ? " (dry run — nothing will be changed)" : ""}\n`);

  let created = 0;
  let dropped = 0;
  let failed = 0;

  for (const Model of MODELS) {
    const name = Model.modelName;
    try {
      if (dryRun) {
        // diffIndexes reports the delta without applying it.
        const diff = await Model.diffIndexes();
        const toCreate = diff.toCreate ?? [];
        const toDrop = diff.toDrop ?? [];
        if (toCreate.length === 0 && toDrop.length === 0) {
          console.log(`   ${name}: up to date`);
        } else {
          console.log(`   ${name}:`);
          for (const idx of toCreate) console.log(`     + create ${JSON.stringify(idx)}`);
          for (const idx of toDrop) console.log(`     - drop   ${JSON.stringify(idx)}`);
        }
        created += toCreate.length;
        dropped += toDrop.length;
      } else {
        // Returns the names of indexes that were dropped.
        const droppedNames = await Model.syncIndexes();
        if (droppedNames.length) {
          console.log(`   ${name}: dropped ${droppedNames.join(", ")}`);
          dropped += droppedNames.length;
        } else {
          console.log(`   ${name}: synced`);
        }
      }
    } catch (err: any) {
      failed++;
      console.error(`   ${name}: FAILED — ${err?.message ?? err}`);
    }
  }

  console.log(
    `\n${dryRun ? "Would create" : "Created/synced"}: ${created}, ` +
    `${dryRun ? "would drop" : "dropped"}: ${dropped}, failed: ${failed}`
  );

  await mongoose.connection.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("ensure-indexes failed:", err);
  process.exit(1);
});
