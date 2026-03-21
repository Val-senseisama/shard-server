import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import SupportFlag from "../../models/SupportFlag.js";
import { cache, cacheInvalidate } from "../../Helpers/Cache.js";

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

    // Update support flag status (Admin/Support only)
    async updateSupportFlag(_, { flagId, status, assignedTo, resolution }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      if (context.role !== "admin") {
        const [myFlagError, myFlag] = await catchError(
          SupportFlag.findById(flagId).lean()
        );

        if (myFlagError || !myFlag || myFlag.userId.toString() !== context.id) {
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

      if (context.role !== "admin") {
        ThrowError("Only admins can view all support flags.");
      }

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
          user: {
            id: f.userId._id.toString(),
            username: f.userId.username,
          },
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

