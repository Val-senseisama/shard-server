# Production Hardening — Working Notes

Running log for the 5-day push to production. Updated as blocks land.

**Scope decision:** 5 days, ship hardening + features together.
**AI-in-group-chat design:** Pro user invokes, all participants read, only the shard owner applies proposals.

---

## Status

| Block | Scope | State |
|---|---|---|
| A | Exposure bugs + auth | ✅ Done |
| B | Achievement stat queries | ✅ Done |
| C | `completeTask` atomicity | ✅ Done |
| D | Tests for A–C | ✅ Done |
| E | Health check, SIGTERM, engines pin, single-instance pin | ✅ Done |
| F | Indexes + TTLs | ✅ Done (script written; **must be run on deploy**) |
| G | Conscious decisions (introspection, rate limits, QuestAI cap) | ✅ Done |
| H | Smoke test + deploy runbook | ✅ Done (`npm run smoke`) |
| I | Task assignment gaps + task-scoped AI in group chat | ✅ Done |

Baseline: 124 tests passing. Now: **176**, typecheck clean, production build green.

New test files: `authz.test.ts` (6), `achievements.test.ts` (10), `taskAtomicity.test.ts` (6),
`scheduler.test.ts` (5), `assignedTasks.test.ts` (8), `questAiGroup.test.ts` (10), plus
additions to `Telemetry.test.ts` and `questai.test.ts`.

Verified by actually running the built server, not just the suite: boots, `/healthz` 200,
SIGTERM drains in 1s and exits 0, `npm run smoke` 10/10.

---

## Deploy runbook

Ordered. Steps 1–2 are prerequisites; 3–6 happen around the deploy itself.

```bash
# 1. Cloudinary — dashboard, not code.
#    Disable any UNSIGNED upload preset. If one exists, the auth fix on
#    getSignedUploadUrl is bypassable entirely and nothing in this repo can stop it.

# 2. Railway — pin to a SINGLE instance.
#    Socket.IO has no Redis adapter; two replicas silently half-break chat and presence.

# 3. Preview the index changes, then apply. 18 declared indexes have never been
#    built — including ones the hourly cron and the notification budget rely on.
npm run ensure:indexes:dry     # read the diff; syncIndexes DROPS undeclared indexes
npm run ensure:indexes

# 4. Deploy.

# 5. Verify against the live URL. Exits non-zero if anything regressed.
npm run smoke -- https://your-api

# 6. Grant the achievements people already earned but never received.
npm run backfill:achievements:dry   # real evaluation, writes nothing
npm run backfill:achievements       # silent grants
```

Optional env: `GRAPHQL_INTROSPECTION=true` to keep Sandbox/Explorer working against
production, `CLIENT_LOG_SECRET` once the mobile client sends the header,
`COACH_DAILY_MESSAGE_CAP` to change the AI coach ceiling from its default of 50.

**Expect a login spike.** The JWT expiry fix invalidates existing sessions — old
(10-day) tokens still verify, but everyone re-authenticates within 15 minutes of their
next refresh. Not an incident.

**Rollback:** tag the current commit before deploying. The only non-reversible step is
the achievement backfill, and leaving those grants in place is harmless.

---

## Block A — Done

| Fix | Location |
|---|---|
| `getShard` IDOR — owner/participant guard; denial shaped identically to "not found" so ids can't be probed | `src/schema/resolvers/Shard.ts:1973` |
| `getSignedUploadUrl` requires auth; uploads scoped to `users/<userId>/` | `src/schema/resolvers/Shard.ts:1909` |
| `/log-errors` rate limited, batch capped at 50, fields truncated, `userId` validated, optional shared secret | `src/index.ts:107` |
| Admin authz reads `role`+`isActive` from DB, not the JWT claim | `src/Helpers/Authz.ts` (new) + 6 call sites |
| `assignTaskFromChat` full authz + junk-task path removed | `src/schema/resolvers/Chat.ts:617` |

### Two findings not in the original audit

**JWT lifetimes were wrong by 1000×.** `setJWT.ts` passed `expiresIn` in milliseconds;
`jsonwebtoken` reads a numeric `expiresIn` as *seconds*. The "15 minute" access token
actually lived **10.4 days**; the refresh token **~822 years**. Fixed to real seconds.

**`logout` revoked nothing.** It wrote an audit row and returned success while the refresh
token stayed in `refreshTokens[]`. Combined with the never-expiring TTL, logging out never
ended a session. It now `$pull`s the presented token's hash.

These compounded: the missing `isActive` check was not a "15-minute lag" but a 10-day one,
and logout could not shorten it.

### Decisions made

- **Per-request fast path stays DB-free.** Deactivation takes effect within the (now real)
  15-min access-token TTL rather than instantly. `adminUpdateUser`'s `forceLogout` clears
  refresh tokens for immediate revocation. Documented at `CreateContext.ts:40`.
- **`assignTaskFromChat` keeps its signature** so the client doesn't break. It now returns
  "Select a task to assign" instead of fabricating a task. *Follow-up ticket: migrate the
  client to `assignMiniGoal`, then delete this mutation.*
- **Client metadata is bounded** into a truncated `details` string rather than spread as
  arbitrary JSON into the document.

---

## ⚠️ Open items requiring action outside this repo

1. **Cloudinary unsigned upload presets.** `src/Helpers/Cloudinary.ts:32` returns
   `uploadPreset: ... || "unsigned"`. If an **unsigned** preset exists on the Cloudinary
   account, anyone can upload with no signature at all and the auth fix is bypassed
   entirely. Disable unsigned presets in the Cloudinary dashboard. *Console change, not code.*

2. **`CLIENT_LOG_SECRET` is optional by design.** Rate limiting and size caps close the DoS
   with no client change. Set the env var and send `x-client-log-secret` once the mobile
   client supports it.

3. **All existing sessions are invalidated** by the JWT expiry fix on deploy. Tokens minted
   under the old (10-day) math still verify, but everyone re-authenticates within 15 minutes
   of their next token refresh. Expect a login spike; it is not an incident.

4. **Run `npm run ensure:indexes` as part of this deploy.** 18 declared indexes have never
   been built (see Block F). Dry-run first.

5. ~~Redis eviction policy~~ — **resolved in code.** BullMQ was removed entirely, so the
   eviction policy no longer matters. Redis is now used only for caching, which already
   degrades gracefully. You can stay on the free tier. See "Constraint-driven decisions".

6. **Set `GRAPHQL_INTROSPECTION=true` in prod** if you want Sandbox/Explorer to keep working
   against production. It is now off by default there.

7. **Pin the deploy to a single instance.** Socket.IO still has no Redis adapter, so two
   replicas silently half-break chat and presence. Platform dashboard setting — there is no
   deploy config file in this repo to encode it in.

---

## Block B — Achievement stat queries — Done

13 of 43 achievements were permanently unreachable:
`friendCount` (4), `tasksCompleted` (6), `miniGoalsCompleted` (3).

Root causes in `buildUserStats` (`src/schema/resolvers/XP.ts:99`):

- Friendship was queried with `requester`/`recipient`; the model uses `user`/`friend`
  (`models/Friendship.ts:4-5`). Matched nothing, always 0.
- The aggregation `$match` compared a JS **string** `userId` against a stored **ObjectId**.
  Mongoose does not cast inside `aggregate()`, so it matched nothing, always 0.
- A dead `MiniGoal.countDocuments({ "shard.owner": ... })` with `.catch(() => 0)` referenced
  a field that does not exist on `MiniGoal`.

Rewrite resolves the user's shard ids once, then hits the `shardId` index directly — removes
both `$lookup` stages and the ObjectId-casting hazard. `collaborationsJoined` now counts
shards owned by *someone else* (the previous filter included a `"viewer"` role that does not
exist in the schema enum).

**Backfill shipped:** `npm run backfill:achievements` (and `:dry`). Batched by `_id` cursor so
it's resumable and can't skip a user, paced to stay out of the way of live traffic, and safe to
re-run — `checkAchievements` only considers achievements a user doesn't already hold.

Grants are **silent** (new `{ silent: true }` option): they populate `pendingAchievements` so
the celebration appears in-app on next open, instead of firing one push per unlock for things
earned weeks ago. That is how people end up disabling notifications for good.

**Dry run against the real database confirmed the fix was worth it: 9 of 17 active users (53%)
were owed achievements — 22 in total.** The names map exactly onto the three broken stats:
*Not Alone / Squad Up / Team Player* (`friendCount`), *First Win / Getting Things Done*
(`tasksCompleted`), *Quest Complete* (`miniGoalsCompleted`).

---

## Block C — `completeTask` atomicity — Done

`completeTask` read the whole `tasks` array and wrote it back wholesale, so two completions in
the same mini-goal lost one update. The read-then-write `completed` guard also allowed double
XP on a double-tap.

Both now claim the task with **one conditional update** and branch on `modifiedCount`, so only
one caller can ever win:

```ts
const claim = await MiniGoal.updateOne(
  { _id: miniGoalId, [`tasks.${taskIndex}.completed`]: false },   // guard lives in the query
  { $set: { [`tasks.${taskIndex}.completed`]: true, ... } }
);
if (claim.modifiedCount === 0) return { success: true, message: "Task already completed.", xpEarned: 0, ... };
```

Progress is then computed from a **re-read**, not the opening snapshot, so a sibling completion
landing mid-flight is not discarded.

Applied to three call sites:
- `completeTask` — atomic claim (`XP.ts`)
- `uncompleteTask` — atomic release guarded on `completed: true`, so two concurrent undos can't
  claw back the XP twice
- `assignMiniGoal` — positional `$set` instead of mutate-and-`save()` (`Shard.ts`)

### Test-mock hazard found while doing this

`undoTask.test.ts` mocked `MiniGoal.updateOne` as `async () => ({})`. With the new code that
returns `modifiedCount: undefined`, so those tests passed *without ever exercising the guard*.
Mock now returns `{ modifiedCount: 1 }`. Worth remembering: any mock of a conditional write
must return a realistic `modifiedCount`.

---

## Block E — Ops readiness — Done

- `GET /healthz` — mounted ahead of the rate limiters (a health probe must never be
  throttled, or a traffic spike reads as the process being down). Returns 503 unless
  `mongoose.connection.readyState === 1`, so a process that is listening but cannot reach its
  database is pulled from the load balancer instead of serving errors.
- `await connectDB()` before `listen()` — it was fire-and-forget, so the server accepted
  traffic while Mongo was still connecting.
- **SIGTERM/SIGINT drain**, registered *before* the DB connect. Atlas cold starts take ~12s
  here, and a SIGTERM in that window previously hit Node's default handler and killed the
  process outright — which is exactly the race a deploy produces.
- `engines: node >=20` pinned (top-level await).

### Shutdown is bounded per step

Each step runs under its own deadline and a failure is logged, not fatal. Every step closes a
connection to something that may itself be sick — often *why* the process is restarting — so
one unreachable dependency degrades that step alone instead of stalling the drain.

Order: sockets → apollo → socket-server → queues → cache → mongo. Measured clean exit (code 0)
in ~10s with Redis unreachable.

**Found: two BullMQ Workers were never closed** (`Queue.ts:38`, `CronJobs.ts:134`). Each holds
a blocking Redis read that keeps the Node event loop alive, so the process could never exit on
its own — the platform would SIGKILL it mid-job every deploy. Added `closeChatQueue()`,
`closeScheduledJobs()`, `closeCache()`.

### Resolved: the `apollo` drain step no longer stalls

`server.stop()` was never resolving, and the cause was `ApolloServerPluginDrainHttpServer`.
Its only job is to close `httpServer` on stop — which the explicit shutdown sequence already
does, in an order that accounts for Socket.IO sharing that same server. Two things were racing
to close one listener, and the plugin sat waiting on connections engine.io held open.

Removed the plugin; the shutdown sequence owns `httpServer` directly.
**Drain went from ~10s with a timeout warning to 1s, every step clean.**

Order: listener → sockets → apollo → queues → cache → mongo.
If you ever delete the shutdown handler, put the plugin back.

## Block F — Indexes — Done, but requires a deploy step

`config/db.ts` connects with `autoIndex: false`, which is correct for production but means a
`schema.index(...)` declaration **does nothing until something builds it**. Added
`src/ensure-indexes.ts` + `npm run ensure:indexes` (and `:dry` for a read-only diff).

### The dry run exposed something significant

**18 declared indexes have never existed in the database.** Indexes the code's own comments say
it depends on were never built:

| Missing index | What runs on it |
|---|---|
| `User.timezone` | hourly local-hour cron buckets — every hour, every bucket |
| `User.lastActive` | dormant/winback campaign scans |
| `User.createdAt` | activation cohorts |
| `Shard {status, lastActivityAt}` | nightly lifecycle sweep |
| `Shard {owner, status}` | free-tier cap check on every quest creation |
| `Notification {userId, priority, dayKey}` | the notification budget check on **every** notify() |
| `Notification {userId, dedupeKey}` | dedupe on every notify() |
| `AnalyticsEvent {name, createdAt}` | funnel queries |

The retention system has been running entirely on collection scans. It is small-data-fast today
and would degrade sharply with users. `npm run ensure:indexes` is therefore not a nice-to-have
on this deploy — it is the deploy step that makes the existing design work as written.

Also added: `User {xp:-1}` (leaderboard), `AuditTrail {userId, createdAt}`, and TTLs on
`ErrorLog` (30d), `AnalyticsEvent` (180d), `AuditTrail` (365d).

⚠️ `syncIndexes()` drops indexes the schemas no longer declare. Run `ensure:indexes:dry` first
and read the diff — anything created by hand in Atlas and not mirrored in a model will go. The
one expected drop is `ErrorLog.createdAt_1`, replaced by its TTL version.

## Block G — Conscious decisions — Done

- **Introspection** is now `!isProd || GRAPHQL_INTROSPECTION === "true"`. It was
  unconditionally on, publishing the full schema in production. **Set `GRAPHQL_INTROSPECTION=true`
  in prod if you want to keep using Sandbox/Explorer there.**
- **Rate limiter keys on the access token** for authenticated traffic, falling back to IP.
  Mobile users behind carrier-grade NAT share one egress IP, so the old IP-only keying put
  thousands of subscribers in a single 120/min bucket — a busy cell tower would throttle
  unrelated users and present as a random, unreproducible outage.
  Uses `ipKeyGenerator` for the fallback: express-rate-limit v8 **refuses to boot** with a
  custom key generator that touches `req.ip` without it. Caught only by actually running the
  built server — typecheck and tests both passed.
- **QuestAI daily cap** (`COACH_DAILY_MESSAGE_CAP`, default 50, env-overridable). Counted off
  `ai_reply` messages, which carry the requesting user as `sender` — one indexed query, no
  join, and it counts what actually costs money (replies generated) rather than messages typed.

## Block I — Assignment + AI coach in the group chat — Done

### I1: `getMyAssignedTasks`

Assignment already worked end to end — `assignMiniGoal` sets the assignee, posts a card into
the quest chat, fires a `task_assigned` push — but the assignee had **no way to see the list**.
A notification you dismiss was the only place the work existed, which is the difference between
a collaborator and a spectator.

Returns assigned tasks across every open quest the caller is in, reusing the existing
`ScheduledTask` type so the client already knows the shape. Covers both levels: a task assigned
individually, and every task under a mini-goal assigned as a whole. Sorted by soonest due date,
undated last; completed and soft-deleted excluded unless asked for.

⚠️ Note for future work: `MiniGoal.assignedTo` is an **ObjectId** while `tasks[].assignedTo` is
a **String**. Both are queried in one `$or`, which is safe because Mongoose casts per-path — but
do not "tidy" them into one shared value without a migration. A string/ObjectId mismatch is
exactly what silently zeroed the achievement stats (Block B).

### I2: task-scoped AI coach, routed through the group chat

As decided: **Pro user invokes, every participant reads, only the quest owner applies.**

- `chatWithQuestAI(shardId, message, miniGoalId, taskIndex)` — the two new args scope the
  question to one mini-goal or one task. Handing the model an entire quest to answer "why is
  this step blocked?" buries the subject and invites it to propose changes nobody asked for.
  Scoped context still includes the quest title and sibling tasks, because advice about one step
  is worthless without knowing what it's a step *toward*.
- **Collaborative quests post into the shard group chat** and broadcast over Socket.IO, so
  participants see the exchange live. Coaching a shared goal in a private thread meant the one
  useful artefact — "here's how we should restructure week 3" — was visible only to whoever
  typed it, and the accountability partner saw nothing.
- **Solo quests keep the private coach thread** (no group chat exists for them), so there are no
  empty rooms for people working alone.
- A `miniGoalId` from another quest is **rejected**, not silently widened back to whole-quest
  context — otherwise a bad id could probe which mini-goals exist by watching the answer change.

#### Tightened `dismissQuestAISuggestion`

`applyQuestAISuggestion` already restricted to the quest owner, which matches the decision.
Dismiss allowed **any chat participant** — fine in a private thread, a griefing vector once
proposals land in the shared chat, since a collaborator could bin a plan change the owner was
still weighing and the card afterwards just reads "dismissed". Narrowed to the quest owner or
whoever asked.

#### Cost note

The daily coach cap (`COACH_DAILY_MESSAGE_CAP`, default 50) is per **asker**, not per quest, so
moving into the group chat does not multiply spend by participant count.

## Constraint-driven decisions (solo maintainer, $10/mo Railway Hobby)

These were judgement calls made against the real budget rather than a generic "best practice"
target. The theme: **remove things that can fail silently**, because a solo maintainer has no
on-call and no staging to catch them.

### BullMQ removed entirely; scheduler moved to node-cron

Your Redis is **Redis Cloud free tier**, which runs `maxmemory-policy volatile-lru` and won't
let you change it. BullMQ requires `noeviction`. Under memory pressure the broker evicts job
data and BullMQ drops those jobs **with no error** — the queue just goes quiet.

What was riding on that queue:
- **The entire retention engine** — every reminder, streak rollover, lifecycle sweep and campaign.
- **Signup verification, password reset and admin OTP emails.** The worst possible jobs to lose
  silently: a user who can't verify their account or get back into it, and nothing reports it.

What the queue bought in exchange: distributed locking across replicas. You have **one**
replica (Socket.IO has no Redis adapter, so the deploy is pinned regardless). So it was pure
downside.

- Scheduler → `node-cron`, which was already a dependency and **completely unused**. Nine jobs,
  pinned to UTC, with an overlap guard so a slow sweep can't race its own next tick (BullMQ
  enforced that; node-cron fires on the clock regardless, and two copies of a sweep would
  double-send notifications).
- `enqueueEmail` → sends inline. Costs the three auth mutations a few hundred ms; they were
  waiting on that email anyway.
- `enqueuePushNotification` → was **dead code**; `Notify.ts` calls Firebase directly so
  budgeting and quiet hours can't be bypassed. Kept as a primitive, now inline.
- `bullmq` uninstalled.

Net: retention keeps running even when Redis is down, one less paid dependency, one less
silent-failure mode, and the eviction warning on every boot goes away.

**Trade-off accepted:** jobs don't survive a restart mid-run, and a deploy during a job loses
that run until its next tick. Every one of these sweeps is idempotent and re-derives its own
state, so that is cheaper than the alternative.

### TTLs sized for a 512MB Atlas free tier

Shortened from the generic values: `ErrorLog` 30d → **14d** (fastest-growing, and the one an
attacker can grow on purpose via `/log-errors`), `AnalyticsEvent` 180d → **90d** (the funnel
defaults to a 30-day window), `AuditTrail` 365d → **90d** (append-only, written on nearly every
mutation — most likely to exhaust storage first).

### No staging: a smoke test safe to run against production

`npm run smoke -- https://your-api` — 10 checks, all read-only or deliberate rejections.
Nothing writes data, creates users, or sends mail. Exits non-zero so it can gate a release.

Covers the security invariants fixed in this pass, which are exactly the ones that are
invisible when broken: unauthenticated upload credentials, quest reads, `currentUser`, admin
queries, the error-log batch cap, depth limit, helmet headers, and DB-backed health.

It does **not** cover the authenticated happy path — that needs real credentials and stays a
manual click-through: signup → create quest → complete a task → XP lands.

## Explicitly NOT in this window

- **Transactions.** Zero `startSession`/`withTransaction` in the codebase. Real fix, multi-day;
  idempotency guards (`completionXPAwarded`) cover the money paths meanwhile.
- **Socket.IO Redis adapter / horizontal scale.** Not needed below ~5k concurrent. Until then
  the deploy is pinned to one instance — see Block E.
- **Moving the at-risk intervention from day 5 to day 2.** Highest-value *retention* change,
  but it needs measurement rather than a rushed edit.
- **Accountability stakes, team billing, pricing.** Product work, not launch-blocking.
