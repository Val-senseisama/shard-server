import {
  catchError,
  logError,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import Report from "../../models/Report.js";
import { User } from "../../models/User.js";
import { cache, cacheInvalidate } from "../../Helpers/Cache.js";

export default {
  Mutation: {
    // Report a user
    async reportUser(_, { reportedUserId, reason, details, reportedItemId, reportedItemType }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      if (context.id === reportedUserId) {
        return {
          success: false,
          message: "You cannot report yourself.",
        };
      }

      // Check if user exists
      const [userError, reportedUser] = await catchError(
        User.findById(reportedUserId).select("username").lean()
      );

      if (userError || !reportedUser) {
        return {
          success: false,
          message: "User not found.",
        };
      }

      // Check for duplicate report (optional: prevent spam)
      const [existingError, existingReport] = await catchError(
        Report.findOne({
          reporterId: context.id,
          reportedUserId,
          status: "pending",
        }).lean()
      );

      if (existingError) {
        logError("reportUser:findExisting", existingError);
      }

      if (existingReport) {
        return {
          success: true,
          message: "You have already reported this user. Thank you for your report.",
        };
      }

      // Create report
      const [createError, report] = await catchError(
        Report.create({
          reporterId: context.id,
          reportedUserId,
          reason,
          details,
          reportedItemId,
          reportedItemType,
          status: "pending",
        })
      );

      if (createError) {
        logError("reportUser:create", createError);
        return {
          success: false,
          message: "Failed to submit report.",
        };
      }

      SaveAuditTrail({
        userId: context.id,
        task: "Reported User",
        details: `Reported user ${reportedUser.username} for: ${reason}`,
      });

      return {
        success: true,
        message: "Report submitted successfully. Our team will review it shortly.",
      };
    },

    // Update report status (Admin only)
    async updateReportStatus(_, { reportId, status, resolution }, context) {
      if (!context.id) ThrowError("Please login to continue.");
      if (context.role !== "admin") {
        ThrowError("Only admins can update report status.");
      }

      const [error, report] = await catchError(
        Report.findByIdAndUpdate(
          reportId,
          {
            status,
            resolution,
            reviewedBy: context.id,
            reviewedAt: new Date(),
          },
          { new: true }
        ).lean()
      );

      if (error || !report) {
        return {
          success: false,
          message: "Report not found.",
        };
      }

      SaveAuditTrail({
        userId: context.id,
        task: "Updated Report Status",
        details: `Updated report ${reportId} to ${status}`,
      });

      return {
        success: true,
        message: "Report status updated successfully.",
      };
    },
  },

  Query: {
    // Get my reports (as reporter)
    async myReports(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [error, reports] = await catchError(
        Report.find({ reporterId: context.id })
          .sort({ createdAt: -1 })
          .select("reason status reviewedAt resolution createdAt")
          .lean()
      );

      if (error) {
        logError("myReports", error);
        return {
          success: false,
          reports: [],
        };
      }

      return {
        success: true,
        reports: reports.map((r: any) => ({
          id: r._id.toString(),
          reason: r.reason,
          status: r.status,
          reviewedAt: r.reviewedAt,
          resolution: r.resolution,
          createdAt: r.createdAt,
        })),
      };
    },

    // Get pending reports (Admin only)
    async getPendingReports(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");
      if (context.role !== "admin") {
        ThrowError("Only admins can view pending reports.");
      }

      const [error, reports] = await catchError(
        Report.find({ status: "pending" })
          .populate("reporterId", "username email")
          .populate("reportedUserId", "username email")
          .sort({ createdAt: -1 })
          .lean()
      );

      if (error) {
        logError("getPendingReports", error);
        return {
          success: false,
          reports: [],
        };
      }

      return {
        success: true,
        reports: reports.map((r: any) => ({
          id: r._id.toString(),
          reporter: {
            id: r.reporterId._id.toString(),
            username: r.reporterId.username,
          },
          reportedUser: {
            id: r.reportedUserId._id.toString(),
            username: r.reportedUserId.username,
          },
          reason: r.reason,
          details: r.details,
          status: r.status,
          createdAt: r.createdAt,
        })),
      };
    },
  },
};

