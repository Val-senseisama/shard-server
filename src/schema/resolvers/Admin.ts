import { DateTime } from "luxon";
import {
  catchError,
  logError,
  MakeID,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import { User } from "../../models/User.js";
import Shard from "../../models/Shard.js";
import Report from "../../models/Report.js";
import SupportFlag from "../../models/SupportFlag.js";
import AuditTrail from "../../models/AuditTrail.js";
import EmailQueue from "../../models/EmailQueue.js";
import Subscription from "../../models/Subscription.js";
import SubscriptionHistory from "../../models/SubscriptionHistory.js";
import setJWT from "../../Helpers/setJWT.js";
import { cache, cacheInvalidate } from "../../Helpers/Cache.js";
import { ACHIEVEMENTS, ACHIEVEMENT_MAP } from "../../data/achievements.js";
import Offering from "../../models/Offering.js";

// ─── Guard ────────────────────────────────────────────────────────────────────
function requireAdmin(context: any) {
  if (!context.id) ThrowError("Please login to continue.");
  if (context.role !== "admin") ThrowError("Admin access required.");
}

// ─── Pagination helper ────────────────────────────────────────────────────────
function paginate(page = 1, limit = 20) {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(100, Math.max(1, limit));
  return { skip: (safePage - 1) * safeLimit, limit: safeLimit };
}

export default {
  // ═══════════════════════════════════════════════════════════════════════════
  // MUTATIONS
  // ═══════════════════════════════════════════════════════════════════════════
  Mutation: {
    /**
     * Step 1 of admin login — sends OTP to an admin email.
     * Does NOT reveal whether the email exists if the user is not admin (security).
     */
    async requestAdminOtp(_, { email }) {
      const normalised = email.toLowerCase().trim();

      const [error, user] = await catchError(
        User.findOne({ email: normalised, role: "admin" })
          .select("_id email username isActive")
          .lean(),
      );

      if (error) {
        logError("requestAdminOtp:find", error);
        return {
          success: false,
          message: "An error occurred. Please try again.",
        };
      }

      // Silently succeed — don't reveal non-admin / non-existent accounts
      if (!user || !user.isActive) {
        return {
          success: true,
          message:
            "If an admin account exists for this email, an OTP has been sent.",
        };
      }

      const otp = MakeID(6); // e.g. "A3K7RX"
      console.log(otp);

      const expiry = DateTime.now().plus({ minutes: 10 }).toISO();

      await User.findByIdAndUpdate(user._id, {
        verificationToken: otp,
        passwordResetExpires: new Date(expiry),
      });

      await EmailQueue.create({
        toEmail: user.email,
        subject: "Shard Admin — Your Login OTP",
        message: `Your admin OTP is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
      });

      SaveAuditTrail({
        userId: user._id.toString(),
        task: "Admin OTP Requested",
        details: `OTP sent to ${user.email}`,
      });

      return {
        success: true,
        message:
          "If an admin account exists for this email, an OTP has been sent.",
      };
    },

    /**
     * Step 2 of admin login — validates OTP, issues JWT.
     */
    async verifyAdminOtp(_, { email, otp }) {
      if (!email || !otp) {
        return { success: false, message: "Email and OTP are required." };
      }

      const normalised = email.toLowerCase().trim();

      const [error, user] = await catchError(
        User.findOne({
          email: normalised,
          role: "admin",
          verificationToken: otp,
        }).lean(),
      );

      if (error) {
        logError("verifyAdminOtp:find", error);
        return {
          success: false,
          message: "An error occurred. Please try again.",
        };
      }

      if (!user) {
        return { success: false, message: "Invalid or expired OTP." };
      }

      // Check expiry
      if (
        !user.passwordResetExpires ||
        new Date(user.passwordResetExpires) < new Date()
      ) {
        return {
          success: false,
          message: "OTP has expired. Please request a new one.",
        };
      }

      // Clear OTP fields
      await User.findByIdAndUpdate(user._id, {
        verificationToken: undefined,
        passwordResetExpires: undefined,
        lastLoginAt: new Date(),
      });

      const tokens = await setJWT(user._id.toString());

      SaveAuditTrail({
        userId: user._id.toString(),
        task: "Admin Login",
        details: `Admin ${user.username} logged in via OTP`,
      });

      return {
        success: true,
        message: "Login successful.",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user._id.toString(),
          email: user.email,
          username: user.username,
          role: user.role,
          profilePic: user.profilePic,
        },
      };
    },

    /**
     * Update a user's account — role, status, RPG stats, force logout.
     */
    async adminUpdateUser(_, { userId, input }, context) {
      requireAdmin(context);

      const allowed = [
        "isActive",
        "role",
        "strength",
        "intelligence",
        "charisma",
        "endurance",
        "creativity",
        "xp",
        "level",
        "aiCredits",
      ];

      const updateData: Record<string, any> = {};
      for (const key of allowed) {
        if (input[key] !== undefined && input[key] !== null) {
          updateData[key] = input[key];
        }
      }

      // Force logout — wipe all refresh tokens
      if (input.forceLogout) {
        updateData.refreshTokens = [];
      }

      if (Object.keys(updateData).length === 0) {
        return { success: false, message: "No valid fields to update." };
      }

      const [error, updated] = await catchError(
        User.findByIdAndUpdate(userId, updateData, { new: true })
          .select("_id username email role isActive")
          .lean(),
      );

      if (error || !updated) {
        logError("adminUpdateUser", error);
        return { success: false, message: "User not found or update failed." };
      }

      // Invalidate user cache
      await cacheInvalidate.user(userId);

      SaveAuditTrail({
        userId: context.id,
        task: "Admin Updated User",
        details: `Admin updated user ${updated.username} (${userId}): ${JSON.stringify(updateData)}`,
      });

      return {
        success: true,
        message: `User ${updated.username} updated successfully.`,
        user: {
          id: updated._id.toString(),
          username: updated.username,
          email: updated.email,
          role: updated.role,
          isActive: updated.isActive,
        },
      };
    },

    /**
     * Grant or revoke a user's subscription.
     */
    async adminUpdateSubscription(_, { userId, tier, endDate }, context) {
      requireAdmin(context);

      const validTiers = ["free", "pro"];
      if (!validTiers.includes(tier)) {
        return { success: false, message: "Invalid subscription tier." };
      }

      const [userErr, user] = await catchError(User.findById(userId));
      if (userErr || !user) {
        return { success: false, message: "User not found." };
      }

      const action = tier === "free" ? "CANCELLATION" : "UPGRADE";

      // 1. Update User model
      const [updateErr] = await catchError(
        User.findByIdAndUpdate(userId, { subscriptionTier: tier as any })
      );

      if (updateErr) {
        logError("adminUpdateSubscription:userUpdate", updateErr);
        return { success: false, message: "Failed to update user tier." };
      }

      // 2. Upsert Subscription record
      const subscriptionData: any = {
        userId,
        tier: tier === "free" ? "free" : "premium", // Current Subscription model uses 'premium'
        status: tier === "free" ? "expired" : "active",
        startDate: new Date(),
      };

      if (endDate) {
        subscriptionData.endDate = new Date(endDate);
      }

      await catchError(
        Subscription.findOneAndUpdate({ userId }, subscriptionData, {
          upsert: true,
          new: true,
        })
      );

      // 3. Log to History
      await catchError(
        SubscriptionHistory.create({
          userId,
          tier,
          action,
          details: `Admin ${context.username || "admin"} ${tier === "free" ? "revoked" : "granted"} ${tier} access.`,
          timestamp: new Date(),
        })
      );

      // 4. Invalidate cache
      await cacheInvalidate.user(userId);

      SaveAuditTrail({
        userId: context.id,
        task: "Admin Updated Subscription",
        details: `Admin changed user ${user.username} tier to ${tier}${endDate ? ` (Expires: ${endDate})` : ""}`,
      });

      return {
        success: true,
        message: `Subscription for ${user.username} updated to ${tier}.`,
      };
    },

    /**
     * Manually grant an achievement to a user.
     */
    async adminGrantAchievement(_, { userId, achievementId }, context) {
      requireAdmin(context);

      const achievement = ACHIEVEMENT_MAP.get(achievementId);
      if (!achievement) {
        return { success: false, message: "Achievement not found." };
      }

      const [userErr, user] = await catchError(User.findById(userId));
      if (userErr || !user) {
        return { success: false, message: "User not found." };
      }

      if (user.achievements?.includes(achievementId)) {
        return { success: false, message: "User already has this achievement." };
      }

      await User.findByIdAndUpdate(userId, {
        $push: {
          achievements: achievementId,
          pendingAchievements: achievementId,
        },
      });

      await cacheInvalidate.user(userId);

      SaveAuditTrail({
        userId: context.id,
        task: "Admin Granted Achievement",
        details: `Admin granted achievement "${achievement.name}" (${achievementId}) to ${user.username}`,
      });

      return {
        success: true,
        message: `Achievement "${achievement.name}" granted to ${user.username}.`,
      };
    },

    /**
     * Manually revoke an achievement from a user.
     */
    async adminRevokeAchievement(_, { userId, achievementId }, context) {
      requireAdmin(context);

      const [userErr, user] = await catchError(User.findById(userId));
      if (userErr || !user) {
        return { success: false, message: "User not found." };
      }

      if (!user.achievements?.includes(achievementId)) {
        return { success: false, message: "User does not have this achievement." };
      }

      await User.findByIdAndUpdate(userId, {
        $pull: {
          achievements: achievementId,
          pendingAchievements: achievementId, // Also remove from pending if it was there
        },
      });

      await cacheInvalidate.user(userId);

      SaveAuditTrail({
        userId: context.id,
        task: "Admin Revoked Achievement",
        details: `Admin revoked achievement "${achievementId}" from ${user.username}`,
      });

      return {
        success: true,
        message: `Achievement revoked from ${user.username}.`,
      };
    },

    /**
     * Update an offering's metadata.
     */
    async adminUpdateOffering(_, { identifier, description }, context) {
      requireAdmin(context);

      const [error, offering] = await catchError(
        Offering.findOneAndUpdate(
          { identifier },
          { description },
          { new: true }
        )
      );

      if (error || !offering) {
        return { success: false, message: "Offering not found." };
      }

      SaveAuditTrail({
        userId: context.id,
        task: "Admin Updated Offering",
        details: `Admin updated offering ${identifier}: ${description}`,
      });

      return { success: true, message: `Offering ${identifier} updated.` };
    },

    /**
     * Update a specific package within an offering.
     */
    async adminUpdatePackage(_, { offeringIdentifier, packageIdentifier, input }, context) {
      requireAdmin(context);

      const offering = await Offering.findOne({ identifier: offeringIdentifier });
      if (!offering) {
        return { success: false, message: "Offering not found." };
      }

      const pkg = offering.packages.find(p => p.identifier === packageIdentifier);
      if (!pkg) {
        return { success: false, message: "Package not found." };
      }

      // Update fields
      if (input.price !== undefined) pkg.price = input.price;
      if (input.priceString !== undefined) pkg.priceString = input.priceString;
      if (input.currencyCode !== undefined) pkg.currencyCode = input.currencyCode;

      await offering.save();

      SaveAuditTrail({
        userId: context.id,
        task: "Admin Updated Package",
        details: `Admin updated package ${packageIdentifier} in ${offeringIdentifier}: ${JSON.stringify(input)}`,
      });

      return { success: true, message: `Package ${packageIdentifier} updated.` };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // QUERIES
  // ═══════════════════════════════════════════════════════════════════════════
  Query: {
    /**
     * Dashboard — runs all stat counts concurrently with Promise.all.
     * No loops; each count is a single indexed DB call.
     */
    async adminDashboard(_, __, context) {
      requireAdmin(context);

      const cacheKey = "admin:dashboard";

      const data = await cache.getOrSet(
        cacheKey,
        async () => {
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);

          const [
            [, totalUsers],
            [, activeToday],
            [, totalShards],
            [, shardsToday],
            [, pendingReports],
            [, openSupportFlags],
            [, bannedUsers],
            [xpErr, xpData],
          ] = await Promise.all([
            catchError(User.countDocuments({})),
            catchError(
              User.countDocuments({ lastActive: { $gte: todayStart } }),
            ),
            catchError(Shard.countDocuments({})),
            catchError(
              Shard.countDocuments({ createdAt: { $gte: todayStart } }),
            ),
            catchError(Report.countDocuments({ status: "pending" })),
            catchError(SupportFlag.countDocuments({ status: "open" })),
            catchError(User.countDocuments({ isActive: false })),
            catchError(
              User.aggregate([
                { $group: { _id: null, totalXP: { $sum: "$xp" } } },
              ]),
            ),
          ]);

          const totalXP = xpData?.[0]?.totalXP ?? 0;

          return {
            totalUsers: totalUsers ?? 0,
            activeToday: activeToday ?? 0,
            totalShards: totalShards ?? 0,
            shardsCreatedToday: shardsToday ?? 0,
            pendingReports: pendingReports ?? 0,
            openSupportFlags: openSupportFlags ?? 0,
            bannedUsers: bannedUsers ?? 0,
            totalXPEarned: totalXP,
          };
        },
        60, // 1-minute cache — dashboard should feel near real-time
      );

      return { success: true, ...data };
    },

    /**
     * Paginated user list with optional search.
     * Single query using an indexed regex on username or email.
     */
    async adminListUsers(_, { search, page, limit }, context) {
      requireAdmin(context);

      const { skip, limit: safeLimit } = paginate(page, limit);

      const filter: any = {};
      if (search && search.trim().length >= 2) {
        const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [
          { username: { $regex: escaped, $options: "i" } },
          { email: { $regex: escaped, $options: "i" } },
        ];
      }

      const [countErr, total] = await catchError(User.countDocuments(filter));
      const [listErr, users] = await catchError(
        User.find(filter)
          .select(
            "_id username email role isActive createdAt lastLoginAt xp level currentStreak subscriptionTier",
          )
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(safeLimit)
          .lean(),
      );

      if (listErr) {
        logError("adminListUsers", listErr);
        return { success: false, users: [], total: 0, page, limit: safeLimit };
      }

      return {
        success: true,
        total: total ?? 0,
        page,
        limit: safeLimit,
        users: (users ?? []).map((u: any) => ({
          id: u._id.toString(),
          username: u.username,
          email: u.email,
          role: u.role ?? "user",
          isActive: u.isActive ?? true,
          xp: u.xp ?? 0,
          level: u.level ?? 1,
          currentStreak: u.currentStreak ?? 0,
          subscriptionTier: u.subscriptionTier,
          lastLoginAt: u.lastLoginAt,
          createdAt: u.createdAt,
        })),
      };
    },

    /**
     * Full user profile for admin drilldown — single query.
     */
    async adminGetUser(_, { userId }, context) {
      requireAdmin(context);

      const [error, user] = await catchError(
        User.findById(userId)
          .select(
            "-passwordHash -refreshTokens -verificationToken -passwordResetToken -passwordResetExpires",
          )
          .lean(),
      );

      if (error || !user) {
        return { success: false, message: "User not found.", user: null };
      }

      return {
        success: true,
        message: "User fetched.",
        user: {
          id: (user as any)._id.toString(),
          username: (user as any).username,
          email: (user as any).email,
          profilePic: (user as any).profilePic,
          bio: (user as any).bio,
          role: (user as any).role ?? "user",
          isActive: (user as any).isActive ?? true,
          emailVerified: (user as any).emailVerified ?? false,
          authProvider: (user as any).authProvider ?? "email",
          xp: (user as any).xp ?? 0,
          level: (user as any).level ?? 1,
          aiCredits: (user as any).aiCredits ?? 0,
          strength: (user as any).strength ?? 5,
          intelligence: (user as any).intelligence ?? 5,
          charisma: (user as any).charisma ?? 5,
          endurance: (user as any).endurance ?? 5,
          creativity: (user as any).creativity ?? 5,
          currentStreak: (user as any).currentStreak ?? 0,
          longestStreak: (user as any).longestStreak ?? 0,
          subscriptionTier: (user as any).subscriptionTier,
          achievements: (user as any).achievements ?? [],
          lastLoginAt: (user as any).lastLoginAt,
          createdAt: (user as any).createdAt,
        },
      };
    },

    /**
     * Paginated report list with populated reporter + reportedUser.
     * Single DB query — no loops.
     */
    async adminGetReports(_, { status, page, limit }, context) {
      requireAdmin(context);

      const { skip, limit: safeLimit } = paginate(page, limit);
      const filter: any = {};
      if (status) filter.status = status;

      const [countErr, total] = await catchError(Report.countDocuments(filter));
      const [listErr, reports] = await catchError(
        Report.find(filter)
          .populate("reporterId", "username email")
          .populate("reportedUserId", "username email")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(safeLimit)
          .lean(),
      );

      if (listErr) {
        logError("adminGetReports", listErr);
        return {
          success: false,
          reports: [],
          total: 0,
          page,
          limit: safeLimit,
        };
      }

      return {
        success: true,
        total: total ?? 0,
        page,
        limit: safeLimit,
        reports: (reports ?? []).map((r: any) => ({
          id: r._id.toString(),
          reporter: r.reporterId
            ? {
                id: r.reporterId._id.toString(),
                username: r.reporterId.username,
              }
            : null,
          reportedUser: r.reportedUserId
            ? {
                id: r.reportedUserId._id.toString(),
                username: r.reportedUserId.username,
              }
            : null,
          reason: r.reason,
          details: r.details,
          status: r.status,
          resolution: r.resolution,
          reportedItemType: r.reportedItemType,
          createdAt: r.createdAt,
          reviewedAt: r.reviewedAt,
        })),
      };
    },

    /**
     * Paginated support flag list with populated userId.
     * Single DB query — no loops.
     */
    async adminGetSupportFlags(_, { status, priority, page, limit }, context) {
      requireAdmin(context);

      const { skip, limit: safeLimit } = paginate(page, limit);
      const filter: any = {};
      if (status) filter.status = status;
      if (priority) filter.priority = priority;

      const [countErr, total] = await catchError(
        SupportFlag.countDocuments(filter),
      );
      const [listErr, flags] = await catchError(
        SupportFlag.find(filter)
          .populate("userId", "username email")
          .sort({ priority: 1, createdAt: -1 }) // high priority first
          .skip(skip)
          .limit(safeLimit)
          .lean(),
      );

      if (listErr) {
        logError("adminGetSupportFlags", listErr);
        return { success: false, flags: [], total: 0, page, limit: safeLimit };
      }

      return {
        success: true,
        total: total ?? 0,
        page,
        limit: safeLimit,
        flags: (flags ?? []).map((f: any) => ({
          id: f._id.toString(),
          user: f.userId
            ? {
                id: f.userId._id.toString(),
                username: f.userId.username,
                email: f.userId.email,
              }
            : null,
          title: f.title,
          issueType: f.issueType,
          priority: f.priority,
          status: f.status,
          description: f.description,
          resolution: f.resolution,
          createdAt: f.createdAt,
          updatedAt: f.updatedAt,
        })),
      };
    },

    /**
     * Searchable, paginated audit trail.
     * Optionally filter by userId; sorted newest-first.
     */
    async adminGetAuditTrail(_, { userId, page, limit }, context) {
      requireAdmin(context);

      const { skip, limit: safeLimit } = paginate(page, limit);
      const filter: any = {};
      if (userId) filter.userId = userId;

      const [countErr, total] = await catchError(
        AuditTrail.countDocuments(filter),
      );
      const [listErr, entries] = await catchError(
        AuditTrail.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(safeLimit)
          .lean(),
      );

      if (listErr) {
        logError("adminGetAuditTrail", listErr);
        return {
          success: false,
          entries: [],
          total: 0,
          page,
          limit: safeLimit,
        };
      }

      return {
        success: true,
        total: total ?? 0,
        page,
        limit: safeLimit,
        entries: (entries ?? []).map((e: any) => ({
          id: e._id.toString(),
          userId: e.userId.toString(),
          task: e.task,
          details: e.details,
          createdAt: e.createdAt,
        })),
      };
    },

    /**
     * Paginated shard overview — single query with owner populated.
     */
    async adminGetShardOverview(_, { status, page, limit }, context) {
      requireAdmin(context);

      const { skip, limit: safeLimit } = paginate(page, limit);
      const filter: any = {};
      if (status) filter.status = status;

      const [countErr, total] = await catchError(Shard.countDocuments(filter));
      const [listErr, shards] = await catchError(
        Shard.find(filter)
          .populate("owner", "username email")
          .select(
            "_id title status progress timeline isPrivate isAnonymous createdAt",
          )
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(safeLimit)
          .lean(),
      );

      if (listErr) {
        logError("adminGetShardOverview", listErr);
        return { success: false, shards: [], total: 0, page, limit: safeLimit };
      }

      return {
        success: true,
        total: total ?? 0,
        page,
        limit: safeLimit,
        shards: (shards ?? []).map((s: any) => ({
          id: s._id.toString(),
          title: s.title,
          status: s.status ?? "active",
          completion: s.progress?.completion ?? 0,
          isPrivate: s.isPrivate ?? false,
          isAnonymous: s.isAnonymous ?? false,
          owner: s.owner
            ? { id: s.owner._id.toString(), username: s.owner.username }
            : null,
          createdAt: s.createdAt,
          endDate: s.timeline?.endDate,
        })),
      };
    },

    adminListAchievementDefinitions(_, __, context) {
      requireAdmin(context);
      return ACHIEVEMENTS;
    },

    /**
     * Get revenue stats for the admin dashboard.
     */
    async adminGetRevenueStats(_, __, context) {
      requireAdmin(context);

      const [statsErr, stats] = await catchError(
        SubscriptionHistory.aggregate([
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: "$amount" },
              activeSubscriptions: {
                $sum: { $cond: [{ $eq: ["$action", "PURCHASE"] }, 1, 0] },
              },
            },
          },
        ])
      );

      const totalRevenue = stats?.[0]?.totalRevenue ?? 0;
      const activeSubscriptions = stats?.[0]?.activeSubscriptions ?? 0;

      // MRR calculation: Sum of prices of all active subscriptions.
      // In a real-world high-volume app, we might cache this or store it in a Stat model.
      // For now, we fetch current prices from the Offering model.
      const offerings = await Offering.find({});
      const priceMap: Record<string, number> = {};
      offerings.forEach(off => {
        off.packages.forEach(pkg => {
          priceMap[pkg.identifier] = pkg.price;
        });
      });

      // Fetch active subscriptions from Subscription model (not history)
      const activeSubs = await Subscription.find({ status: "active" });
      let mrr = 0;
      activeSubs.forEach(sub => {
        // Map sub.tier (e.g. 'premium') to a package if possible, or use a default.
        // Actually, our current Subscription model uses 'free' or 'premium'.
        // Let's assume 'premium' maps to 'monthly' price for MRR estimation.
        if (sub.tier === "premium") {
          mrr += priceMap["monthly"] || 9.99;
        }
      });

      const [recentErr, recent] = await catchError(
        SubscriptionHistory.find({})
          .populate("userId", "username email")
          .sort({ timestamp: -1 })
          .limit(10)
          .lean()
      );

      return {
        mrr,
        totalRevenue,
        activeSubscriptions,
        churnRate: 5.0, 
        recentTransactions: (recent || []).map((h: any) => ({
          id: h._id.toString(),
          user: h.userId ? { id: h.userId._id.toString(), username: h.userId.username } : null,
          tier: h.tier,
          action: h.action,
          amount: h.amount,
          currency: h.currency,
          timestamp: h.timestamp.toISOString(),
        })),
      };
    },

    /**
     * List all subscription history records.
     */
    async adminListSubscriptions(_, { page = 1, limit = 20 }, context) {
      requireAdmin(context);
      const { skip, limit: safeLimit } = paginate(page, limit);

      const [countErr, total] = await catchError(SubscriptionHistory.countDocuments({}));
      const [listErr, list] = await catchError(
        SubscriptionHistory.find({})
          .populate("userId", "username email")
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(safeLimit)
          .lean()
      );

      return {
        success: true,
        total: total ?? 0,
        page,
        limit: safeLimit,
        subscriptions: (list || []).map((h: any) => ({
          id: h._id.toString(),
          user: h.userId ? { id: h.userId._id.toString(), username: h.userId.username } : null,
          tier: h.tier,
          action: h.action,
          amount: h.amount,
          currency: h.currency,
          timestamp: h.timestamp.toISOString(),
        })),
      };
    },

    /**
     * List project offerings (plans).
     */
    async adminListOfferings(_, __, context) {
      requireAdmin(context);
      
      const offerings = await Offering.find({}).lean();
      return offerings;
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // FIELD RESOLVERS
  // ═══════════════════════════════════════════════════════════════════════════
  AdminUserDetail: {
    async subscriptionHistory(parent: any) {
      const [error, history] = await catchError(
        SubscriptionHistory.find({ userId: parent.id })
          .sort({ timestamp: -1 })
          .lean()
      );

      if (error) return [];

      return (history || []).map((h: any) => ({
        id: h._id.toString(),
        tier: h.tier,
        action: h.action,
        amount: h.amount,
        currency: h.currency,
        details: h.details,
        timestamp: h.timestamp.toISOString(),
      }));
    },
  },
};
