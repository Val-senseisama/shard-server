# Shard — Server Report

_A concise map of the backend: what it is, how it's built, and its current state._

## Overview
**Shard** is the backend for an AI, gamified goal-tracker. Users turn real goals into RPG-style
**quests** (a "Shard" → mini-goals → tasks) with XP, levels, streaks, achievements, and
social/collaboration features. AI (Groq/Llama) breaks goals into structured plans and coaches users.

## Stack
- **API:** Apollo Server 5 (GraphQL) on Express 5, `@as-integrations/express5`.
- **Data:** MongoDB via Mongoose 8.
- **Async/jobs:** BullMQ + Redis (ioredis) for queues and repeatable cron jobs.
- **Realtime:** Socket.io (chat delivery).
- **AI:** Groq SDK (`llama-3.3-70b` heavy / `llama-3.1-8b` light).
- **Integrations:** RevenueCat (billing webhook), Firebase Admin (push), Resend/Nodemailer (email),
  Cloudinary (uploads), Google Auth (OAuth), JWT (auth).
- **Runtime:** TypeScript (ESM, NodeNext-style `.js` specifiers), Node.

## Structure
- `src/schema/Typedefinitions.ts` — GraphQL SDL. `src/schema/Resolvers.ts` — wires all resolver groups
  (wraps each in `withErrorLogging`).
- `src/schema/resolvers/*` — Admin, Analytics, Challenge, Chat, Friendship, Notifications,
  PushNotifications, **QuestAI**, Report, Shard, SideQuest, Support, Team, User, XP.
- `src/models/*` — User, Shard, MiniGoal, Chat (+Message), SideQuest, Analytics, Friendship, Streak,
  Team, Challenge, Notifications(+Preferences), Report, SupportFlag, Subscription, SubscriptionHistory,
  Offering, Achievement, AuditTrail, ErrorLog, EmailQueue, SocialShare.
- `src/Helpers/*` — AIHelper, **Entitlements** (paywall), Cache, CronJobs, Queue, DateHelper,
  StreakHelper, ContentModerator, FirebaseMessaging, ResendEmail/SendMail, Cloudinary, GoogleAuth,
  PasswordHash, setJWT, Validate, Helpers.
- `src/controllers/WebhookController.ts` — RevenueCat webhook (fail-closed, idempotent by transaction).

## Core domain
- **Shard** (quest) → **MiniGoal**s → embedded **tasks**. AI (`breakDownGoalWithAI`) or manual creation;
  `smartSchedule` distributes task due-dates across working days.
- **Gamification:** XP/levels (`XP.ts`), streaks (`StreakHelper`), achievements, side quests.
- **Social/collab:** friendships, shard participants/roles, per-shard group chat, teams, challenges.
- **AI Quest Coach (QuestAI):** private per-shard AI thread — explain/refine quests via
  **propose-then-confirm** (AI emits a whitelisted-op diff → user applies → fans out to existing
  Shard resolvers). Pro-only.

## Scheduled jobs (BullMQ, `CronJobs.ts`)
overdue-task-reschedule (3am), deleted-task-purge (4am), daily-task-reminders (7:30), deadline-reminders
(8am), overdue-alerts (9am), inactivity-nudger (10am), streak-event-detector (11am),
notification-dispatcher (every 5m), **monthly-credit-refill** (1st of month).

## Monetization / entitlement (enforced)
- One paid plan: **Shard Pro** (RevenueCat entitlement "Thinkertech Pro").
- **Trusted source of truth = `User.subscriptionTier`** (`pro`/`enterprise`), written only by the
  RevenueCat webhook + admin. Never a client flag. `Helpers/Entitlements.ts` centralizes `tierOf`/
  `isEntitled` (admin bypass), `countActiveShards`, `upgradeError`.
- **Free limits (server-enforced):** max **3 active Shards**; **100 AI credits/mo** (monthly refill
  cron), metered on quest breakdown, regenerate, side-quest AI, chat summary; advanced analytics
  (`getProductivityData`) and the AI Quest Coach are **Pro-only**. Social + streaks stay free.
- Failure contract: gated resolvers return `{ success:false, needsUpgrade:true, message }`.
- See `MONETIZATION_REPORT.md` for the revenue-planning brief.

## Auth & safety
- JWT-based (`context.id`); OAuth via Google. Passwords bcrypt-hashed.
- All AI input/output passes `ContentModerator.moderate` + prompt-level `SAFETY_RULES`.
- Webhook fails closed on missing secret; idempotent by `transaction_id`.

## Tests & build
- `npm run build` (tsc) — typechecks clean. `npm test` (vitest) — **18 tests**: entitlement helper,
  paywall resolver gates (free vs Pro), and QuestAI (Pro gate, apply fan-out, IDOR guard).
- **Not yet covered:** end-to-end/integration against live Mongo/Redis/Groq; most non-paywall
  resolvers lack unit tests.

## Known gaps / follow-ups
- RevenueCat webhook maps event type → tier but does **not** verify the specific entitlement id.
- `Subscription` model is vestigial (webhook doesn't write it; `Admin.ts` queries a non-existent
  `status` field) — don't use it for entitlement.
- AI Quest Coach persists messages but does **not** emit over Socket.io yet (client must refetch).
- Broader integration-test coverage and load/perf validation of the queue/cron subsystem.
