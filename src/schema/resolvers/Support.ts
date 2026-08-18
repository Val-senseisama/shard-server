import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import SupportFlag from "../../models/SupportFlag.js";
import { cache, cacheInvalidate } from "../../Helpers/Cache.js";
import { assertAdmin, isAdmin } from "../../Helpers/Authz.js";

const ISSUE_TYPES = ["bug", "feature_request", "complaint", "other"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

/** Anti-flood window for the unauthenticated public form. */
const PUBLIC_WINDOW_MS = 60 * 60 * 1000;
const PUBLIC_MAX_PER_WINDOW = 5;

export default {
  Mutation: {
    // Create support flag
    async createSupportFlag(_, { input }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, flag] = await catchError(
        SupportFlag.create({
          userId: context.id,
          issueType: input.issueType,
          title: input.title,
          description: input.description,
          priority: input.priority || "low",
          attachments: input.attachments || [],
          status: "open",
        })
      );

      if (error) {
        logError("createSupportFlag", error);
        return {
          success: false,
          message: "Failed to create support ticket.",
        };
      }

      SaveAuditTrail({
        userId: context.id,
        task: "Created Support Ticket",
        details: `Created support ticket: ${input.title}`,
      });

      return {
        success: true,
        message: "Support ticket created successfully. We'll get back to you soon.",
        flag: {
          id: flag._id.toString(),
          title: flag.title,
          issueType: flag.issueType,
          priority: flag.priority,
          status: flag.status,
        },
      };
    },

    /**
     * Create a ticket from the public support form on shard.app.
     *
     * Unauthenticated by design: a large share of real support mail is "I can't
     * log in", which an authenticated-only endpoint can never receive. The
     * landing site validates too, but never trust that — this is a public
     * mutation and the validation here is the one that counts.
     */
    async createPublicSupportRequest(_, { input }) {
      const name = (input.name ?? "").trim();
      const email = (input.email ?? "").trim().toLowerCase();
      const title = (input.title ?? "").trim();
      const description = (input.description ?? "").trim();

      if (!name || !email || !title || !description || !input.issueType) {
        return { success: false, message: "All fields are required." };
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { success: false, message: "Please enter a valid email address." };
      }
      if (name.length > 120 || title.length > 120) {
        return { success: false, message: "Name and subject must be under 120 characters." };
      }
      if (description.length > 2000) {
        return { success: false, message: "Description must be under 2000 characters." };
      }
      if (!ISSUE_TYPES.includes(input.issueType)) {
        return { success: false, message: "Unknown issue type." };
      }

      // Cheap anti-flood guard. The transport limiter in index.ts keys anonymous
      // traffic on IP, which does nothing against a form submitted repeatedly
      // from rotating addresses. Collapsing repeat sends from one address inside
      // a short window costs one indexed lookup and stops the common case.
      const [dupeErr, recent] = await catchError(
        SupportFlag.countDocuments({
          guestEmail: email,
          createdAt: { $gt: new Date(Date.now() - PUBLIC_WINDOW_MS) },
        })
      );
      if (!dupeErr && (recent ?? 0) >= PUBLIC_MAX_PER_WINDOW) {
        return {
          success: false,
          message:
            "We've already got a few tickets from this address. We'll reply to those first.",
        };
      }

      const [error] = await catchError(
        SupportFlag.create({
          guestName: name,
          guestEmail: email,
          issueType: input.issueType,
          title,
          description,
          priority: PRIORITIES.includes(input.priority) ? input.priority : "low",
          status: "open",
        })
      );

      if (error) {
        logError("createPublicSupportRequest", error);
        return {
          success: false,
          message: "We couldn't submit that. Please try again, or email support@shard.app.",
        };
      }

      // No SaveAuditTrail here: it expects a userId, and there isn't one.

      return {
        success: true,
        message: "Thanks — your ticket is in. We'll reply by email.",
      };
    },

    // Update support flag status (Admin/Support only)
    async updateSupportFlag(_, { flagId, status, assignedTo, resolution }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      if (!(await isAdmin(context))) {
        const [myFlagError, myFlag] = await catchError(
          SupportFlag.findById(flagId).lean()
        );

        // userId is optional now (guest tickets). Optional-chain it: an
        // unguarded .toString() threw a TypeError on guest tickets instead of
        // the intended "not yours" rejection.
        if (myFlagError || !myFlag || myFlag.userId?.toString() !== context.id) {
          ThrowError("You can only update your own support tickets.");
        }
      }

      const [error, flag] = await catchError(
        SupportFlag.findByIdAndUpdate(
          flagId,
          {
            ...(status && { status }),
            ...(assignedTo && { assignedTo }),
            ...(resolution && { resolution }),
            ...(status === "resolved" && {
              resolvedBy: context.id,
              resolvedAt: new Date(),
            }),
          },
          { new: true }
        ).lean()
      );

      if (error || !flag) {
        return {
          success: false,
          message: "Support flag not found.",
        };
      }

      SaveAuditTrail({
        userId: context.id,
        task: "Updated Support Flag",
        details: `Updated support flag ${flagId} to ${status}`,
      });

      return {
        success: true,
        message: "Support flag updated successfully.",
        flag: {
          id: flag._id.toString(),
          title: flag.title,
          issueType: flag.issueType,
          status: flag.status,
          priority: flag.priority,
        },
      };
    },
  },

  Query: {
    // Get my support flags
    async mySupportFlags(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, flags] = await catchError(
        SupportFlag.find({ userId: context.id })
          .sort({ createdAt: -1 })
          .select("title issueType priority status resolution updatedAt createdAt")
          .lean()
      );

      if (error) {
        logError("mySupportFlags", error);
        return {
          success: false,
          flags: [],
        };
      }

      return {
        success: true,
        flags: flags.map((f: any) => ({
          id: f._id.toString(),
          title: f.title,
          issueType: f.issueType,
          priority: f.priority,
          status: f.status,
          resolution: f.resolution,
          updatedAt: f.updatedAt,
          createdAt: f.createdAt,
        })),
      };
    },

    // Get all support flags (Admin only)
    async getAllSupportFlags(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      await assertAdmin(context);

      const [error, flags] = await catchError(
        SupportFlag.find()
          .populate("userId", "username email")
          .sort({ priority: 1, createdAt: -1 })
          .lean()
      );

      if (error) {
        logError("getAllSupportFlags", error);
        return {
          success: false,
          flags: [],
        };
      }

      return {
        success: true,
        flags: flags.map((f: any) => ({
          id: f._id.toString(),
          // Guest tickets from the public form have no userId. This used to
          // dereference it unguarded, so one guest ticket threw and took the
          // whole admin list down with it.
          user: f.userId
            ? {
                id: f.userId._id.toString(),
                username: f.userId.username,
              }
            : null,
          guestName: f.guestName ?? null,
          guestEmail: f.guestEmail ?? null,
          title: f.title,
          issueType: f.issueType,
          priority: f.priority,
          status: f.status,
          updatedAt: f.updatedAt,
          createdAt: f.createdAt,
        })),
      };
    },
  },
};

