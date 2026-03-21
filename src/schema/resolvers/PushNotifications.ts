import {
  catchError,
  logError,
  ThrowError,
} from "../../Helpers/Helpers.js";
import { User } from "../../models/User.js";
import { sendNotificationToUser } from "../../Helpers/FirebaseMessaging.js";

export default {
  Mutation: {
    // Register push token
    async registerPushToken(_, { token, platform, deviceId }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      console.log(`📱 Registering push token for user ${context.id}: ${token.substring(0, 10)}...`);

      const [error, user] = await catchError(
        User.findById(context.id)
      );

      if (error || !user) {
        return {
          success: false,
          message: "User not found.",
        };
      }

      // Check if token already exists
      const existingTokenIndex = user.pushTokens?.findIndex(t => t.token === token);

      if (existingTokenIndex > -1) {
        // Update existing token
        user.pushTokens[existingTokenIndex].lastUsed = new Date();
        user.pushTokens[existingTokenIndex].platform = platform;
        if (deviceId) user.pushTokens[existingTokenIndex].deviceId = deviceId;
      } else {
        // Add new token
        if (!user.pushTokens) user.pushTokens = [];
        user.pushTokens.push({
          token,
          platform,
          deviceId,
          registeredAt: new Date(),
          lastUsed: new Date(),
        });
      }

      await user.save();

      return {
        success: true,
        message: "Push token registered successfully.",
      };
    },

    // Unregister push token
    async unregisterPushToken(_, { token }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      await User.findByIdAndUpdate(context.id, {
        $pull: { pushTokens: { token } }
      });

      return {
        success: true,
        message: "Push token unregistered successfully.",
      };
    },

    // Send test notification
    async sendTestNotification(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      console.log(`🧪 Sending test notification to user ${context.id}...`);

      // Check if user has tokens first
      const [userError, user] = await catchError(
        User.findById(context.id).select('pushTokens')
      );

      if (userError || !user) {
        console.log('❌ User not found for test notification');
        return {
          success: false,
          message: "User not found.",
        };
      }

      if (!user.pushTokens || user.pushTokens.length === 0) {
        console.log(`❌ User ${context.id} has no registered push tokens`);
        return {
          success: false,
          message: "No push tokens registered. Please restart the app to register your device.",
        };
      }

      console.log(`📱 User has ${user.pushTokens.length} token(s). Sending notification...`);

      const success = await sendNotificationToUser(context.id, {
        title: "Test Notification",
        body: "This is a test notification from Shard!",
        data: { screen: "/notifications" }
      });

      if (success) {
        console.log(`✅ Test notification sent successfully to user ${context.id}`);
        return {
          success: true,
          message: "Test notification sent!",
        };
      } else {
        console.log(`❌ Failed to send test notification to user ${context.id}`);
        return {
          success: false,
          message: "Failed to send notification to FCM. Check that Firebase is properly configured.",
        };
      }
    }
  }
};
