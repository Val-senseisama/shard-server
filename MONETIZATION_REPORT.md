# Shard — Monetization Brief (for an AI planner)

**What it is:** "Shard" — an AI, gamified goal-tracker. Users turn real-life goals into RPG-style
"quests" (Shards → mini-goals → tasks) with XP, levels, streaks, and social/collab features. AI
(Groq/Llama) breaks goals into structured plans and coaches the user.

**Stack:** Apollo Server 5 / GraphQL, MongoDB (Mongoose), BullMQ+Redis (cron/queues), Socket.io
(chat), Firebase (push), RevenueCat (billing). Mobile client is the paying surface.

## Current monetization
- One paid plan: **Shard Pro** (RevenueCat entitlement "Thinkertech Pro"). Tiers: `free` / `pro`
  (`enterprise` exists in the model, unused).
- **Trusted entitlement = `User.subscriptionTier`**, written only by the RevenueCat webhook +
  admin. Never trust a client flag.
- **Paywall is now enforced server-side (Phase 0):**
  - Free = **max 3 active Shards**; Pro = unlimited.
  - **AI is metered by `aiCredits`** (free: 100/mo, refilled by monthly cron; Pro: unlimited).
    Metered paths: quest breakdown, regenerate, side-quest AI, chat summary.
  - **Advanced analytics (`getProductivityData`) is Pro-only.**
  - Social + streaks stay **free** (drive virality + retention).
- **In progress (Phase 1):** conversational AI quest-chat (explain/refine shards) — **Pro-only**.

## Revenue levers to explore (highest → lowest leverage)
1. **Conversion surface:** every gated resolver returns `needsUpgrade: true` — instrument these
   hits as an upgrade-intent funnel; A/B the paywall copy and the free caps (3 shards, 100 credits).
2. **AI is the willingness-to-pay driver** — the free credit ceiling is the core lever. Tune credit
   cost per feature; consider a credit top-up IAP in addition to subscription.
3. **New Pro-only value:** AI quest-chat (Phase 1), unlimited/advanced analytics, team/accountability
   features, richer coaching (currently Pro gets AI nudges, free gets templates).
4. **Tiering:** activate `enterprise`/team plans (collab, shared shards already exist in the schema).
5. **Retention = LTV:** streaks, notifications, and reflection missions already exist — lifting
   retention compounds subscription revenue more than new-user acquisition.

## Constraints / watch-outs
- All AI cost flows through Groq — every free-AI path is a direct COGS leak; keep them metered.
- Webhook maps event type → tier but does **not** verify the specific entitlement id (future hardening).
- `Subscription` model is vestigial; don't use it for entitlement (`User.subscriptionTier` only).
