/**
 * One-off backfill for `MiniGoal.order`.
 *
 * Mini-goals are written with `Promise.all`, so their insertion order is
 * whichever concurrent write landed first, and readers either sorted by
 * `createdAt` or — in the case of `getShard`, the one the shard screen uses —
 * not at all. The client renders that array as "1. …, 2. …", so an approved
 * four-phase plan could come back with its phases shuffled. `order` gives the
 * sequence somewhere to live; this fills it in for everything already created.
 *
 *     npm run backfill:minigoal-order:dry    # report only, writes nothing
 *     npm run backfill:minigoal-order        # write
 *
 * Safe to re-run and safe to interrupt. Order is recomputed from
 * `(sourceSectionIndex, createdAt)` — both immutable — so a second pass over the
 * same shard produces the same numbers. There is no user-facing reorder feature
 * whose result this could overwrite; when one exists, this script must not be
 * run again without revisiting that assumption.
 *
 * `sourceSectionIndex` leads because on a course shard it IS the curriculum
 * order and is trustworthy. `createdAt` is the best guess available everywhere
 * else — it's what the old readers used, so this preserves whatever order users
 * have been looking at rather than inventing a new one.
 */
import "dotenv/config";
import mongoose from "mongoose";
import Shard from "./models/Shard.js";
import MiniGoal from "./models/MiniGoal.js";

const dryRun = process.argv.includes("--dry-run");

/** Shards per batch. Each costs one indexed read plus a bulk write. */
const BATCH_SIZE = 100;

/** Pause between batches, so a backfill can't starve request traffic. */
const BATCH_PAUSE_MS = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set.");
    process.exit(1);
  }

  await mongoose.connect(uri, { autoIndex: false });
  console.log(`✅ Connected${dryRun ? "  (DRY RUN — nothing will be written)" : ""}\n`);

  const total = await Shard.countDocuments({});
  console.log(`Scanning ${total} shards in batches of ${BATCH_SIZE}...\n`);

  let scanned = 0;
  let shardsChanged = 0;
  let miniGoalsWritten = 0;
  let alreadyOrdered = 0;

  for (let skip = 0; skip < total; skip += BATCH_SIZE) {
    const shards = await Shard.find({}, "_id title").skip(skip).limit(BATCH_SIZE).lean();

    for (const shard of shards) {
      scanned++;

      const miniGoals = await MiniGoal.find({ shardId: shard._id })
        .select("_id order sourceSectionIndex createdAt")
        .lean();

      if (miniGoals.length === 0) continue;

      const sorted = [...miniGoals].sort((a, b) => {
        const ai = (a as any).sourceSectionIndex ?? Infinity;
        const bi = (b as any).sourceSectionIndex ?? Infinity;
        if (ai !== bi) return ai - bi;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });

      // Only write where the value actually differs, so a re-run is a no-op and
      // the report distinguishes "already correct" from "fixed".
      const ops = sorted
        .map((mg, index) => ({ mg, index }))
        .filter(({ mg, index }) => (mg as any).order !== index)
        .map(({ mg, index }) => ({
          updateOne: {
            filter: { _id: mg._id },
            update: { $set: { order: index } },
          },
        }));

      if (ops.length === 0) {
        alreadyOrdered++;
        continue;
      }

      shardsChanged++;
      miniGoalsWritten += ops.length;

      if (!dryRun) {
        await MiniGoal.bulkWrite(ops);
      }
    }

    console.log(`  …${Math.min(skip + BATCH_SIZE, total)} / ${total}`);
    await sleep(BATCH_PAUSE_MS);
  }

  console.log(`\nShards scanned: ${scanned}`);
  console.log(`Already in order: ${alreadyOrdered}`);
  console.log(
    `${dryRun ? "Shards that would change" : "Shards changed"}: ${shardsChanged} ` +
      `(${miniGoalsWritten} mini-goals)`
  );

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
