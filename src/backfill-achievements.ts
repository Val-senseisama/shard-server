/**
 * One-off backfill for the achievement fix.
 *
 * Three bugs in `buildUserStats` (see Block B of HARDENING_NOTES.md) made 13 of
 * the 43 achievements permanently unreachable — every `friendCount`,
 * `tasksCompleted` and `miniGoalsCompleted` tier. Users earned those and were
 * never granted them. Fixing the queries only helps from the next completion
 * onwards; this grants what people already earned.
 *
 *     npm run backfill:achievements:dry    # report only, writes nothing
 *     npm run backfill:achievements        # grant
 *
 * Safe to re-run. `checkAchievements` only ever considers achievements a user
 * doesn't already hold, so a second pass over the same user is a no-op — which
 * also means it is safe to interrupt and resume.
 *
 * Grants are SILENT: they populate `pendingAchievements` so the user sees the
 * celebration in-app on their next open, rather than receiving a pile of push
 * notifications for things they earned weeks ago. That distinction is the whole
 * reason this isn't just a for-loop over the live path.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { User } from "./models/User.js";
import { checkAchievements, buildUserStats } from "./schema/resolvers/XP.js";
import { ACHIEVEMENT_MAP, ACHIEVEMENTS } from "./data/achievements.js";

const dryRun = process.argv.includes("--dry-run");

/**
 * Users processed per batch. Each user costs several indexed reads
 * (`buildUserStats` resolves their shards, then aggregates tasks and mini-goals),
 * so this is latency-bound. Small batches keep memory flat and leave the database
 * responsive for live traffic — this is expected to run against production while
 * it is serving.
 */
const BATCH_SIZE = 50;

/** Pause between batches, so a backfill can't starve request traffic. */
const BATCH_PAUSE_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What `checkAchievements` WOULD grant, without writing anything.
 *
 * Deliberately mirrors the real evaluation — same stats builder, same thresholds,
 * same "skip what they already hold" filter — so a dry run is a genuine preview
 * rather than a guess.
 */
async function evaluateWouldUnlock(userId: string, held: string[]): Promise<string[]> {
  const earned = new Set(held);
  const toCheck = ACHIEVEMENTS.filter((a) => !earned.has(a.id));
  if (toCheck.length === 0) return [];

  const stats = await buildUserStats(userId);
  if (!stats) return [];

  return toCheck
    .filter((a) => (stats[a.condition.stat] ?? 0) >= a.condition.threshold)
    .map((a) => a.id);
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set.");
    process.exit(1);
  }

  await mongoose.connect(uri, { autoIndex: false });
  console.log(`✅ Connected${dryRun ? "  (DRY RUN — nothing will be written)" : ""}\n`);

  const total = await User.countDocuments({ isActive: true });
  console.log(`Scanning ${total} active users in batches of ${BATCH_SIZE}...\n`);

  let scanned = 0;
  let changed = 0;
  let granted = 0;
  let failed = 0;
  const tally = new Map<string, number>();

  // Paginate by _id rather than skip/limit: skip re-scans the collection on every
  // batch, and a concurrent signup would shift the window and silently skip a user.
  let cursor: mongoose.Types.ObjectId | null = null;

  for (;;) {
    const filter: Record<string, any> = { isActive: true };
    if (cursor) filter._id = { $gt: cursor };

    const batch = await User.find(filter, "_id username achievements")
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();

    if (batch.length === 0) break;

    for (const user of batch as any[]) {
      const id = user._id.toString();
      scanned++;

      try {
        // Run the SAME evaluation in both modes — the dry run computes the real
        // stats and applies the real thresholds, it just doesn't write. A dry run
        // that only guesses is worse than none: it would tell you the backfill is
        // safe without having checked anything it claims to.
        const unlocked = dryRun
          ? await evaluateWouldUnlock(id, user.achievements ?? [])
          : await checkAchievements(id, { silent: true });

        if (unlocked.length > 0) {
          changed++;
          granted += unlocked.length;
          for (const a of unlocked) tally.set(a, (tally.get(a) ?? 0) + 1);
          const names = unlocked.map((a) => ACHIEVEMENT_MAP.get(a)?.name ?? a);
          console.log(`   ${dryRun ? "·" : "✓"} ${user.username ?? id}: +${unlocked.length} — ${names.join(", ")}`);
        }
      } catch (err: any) {
        failed++;
        console.error(`   ✗ ${user.username ?? id}: ${err?.message ?? err}`);
      }
    }

    cursor = (batch[batch.length - 1] as any)._id;
    if (scanned % 500 === 0) console.log(`   … ${scanned}/${total}`);
    await sleep(BATCH_PAUSE_MS);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Scanned:  ${scanned}`);
  console.log(`${dryRun ? "Users who would gain" : "Users granted"}: ${changed}`);
  console.log(`${dryRun ? "Achievements that would be granted" : "Achievements granted"}: ${granted}`);
  if (failed) console.log(`Failed: ${failed}`);

  if (tally.size > 0) {
    console.log(`\nBy achievement:`);
    [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([id, n]) => console.log(`   ${(ACHIEVEMENT_MAP.get(id)?.name ?? id).padEnd(28)} ${n}`));
  }

  if (!dryRun && changed > 0) {
    console.log(
      `\nGranted silently — users will see these in-app on next open via ` +
      `pendingAchievements. No push notifications were sent.`
    );
  }

  await mongoose.connection.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
