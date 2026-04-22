import { DateTime } from "luxon";
import { createHash } from "crypto";
import {
  catchError,
  logError,
  MakeID,
  SaveAuditTrail,
  ThrowError,
} from "../../Helpers/Helpers.js";
import SendMail from "../../Helpers/SendMail.js";
import setJWT from "../../Helpers/setJWT.js";
import { hashPassword, comparePassword, validatePassword } from "../../Helpers/PasswordHash.js";
import { User } from "../../models/User.js";
import EmailQueue from "../../models/EmailQueue.js";
import Friendship from "../../models/Friendship.js";
import { getCloudinarySignedUpload } from "../../Helpers/Cloudinary.js";
import { verifyGoogleToken, generateUsernameFromGoogle } from "../../Helpers/GoogleAuth.js";
import { moderate } from "../../Helpers/ContentModerator.js";
import { cache, cacheKeys, cacheInvalidate } from "../../Helpers/Cache.js";

export default {
  Mutation: {
    // Sign up with password
    async signup(_, { input }) {
      const { email, password, username } = input;

      // Moderate username at signup
      const signupMod = moderate(username, 'public_profile');
      if (!signupMod.allowed)
        return { success: false, message: signupMod.reason || 'This username is not allowed.' };

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return {
          success: false,
          message: "Invalid email format.",
        };
      }

      // Validate password strength
      if (!validatePassword(password)) {
        return {
          success: false,
          message: "Password must be at least 8 characters with uppercase, lowercase, and number.",
        };
      }

      // Check if user already exists
      const [existingError, existingUser] = await catchError(
        User.findOne({ $or: [{ email }, { username }] }).lean()
      );

      if (existingError) {
        logError("signup:findExisting", existingError);
        return {
          success: false,
          message: "An error occurred. Please try again.",
        };
      }

      if (existingUser) {
        return {
          success: false,
          message: "User with this email or username already exists.",
        };
      }

      // Hash password
      const passwordHash = await hashPassword(password);

      // Pre-compute search hash for email
      const emailHash = createHash('sha256').update(email.toLowerCase()).digest('hex');

      // Generate default avatar URL
      const defaultAvatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=667eea&color=fff&size=150`;

      // Create new user
      const [createError, newUser] = await catchError(
        User.create({
          email,
          username,
          passwordHash,
          emailHash,
          profilePic: defaultAvatarUrl,
          emailVerified: false,
          role: "user",
          isActive: true,
          authProvider: 'password',
          // Initialize RPG stats (same as Google signup)
          strength: 5,
          intelligence: 5,
          charisma: 5,
          endurance: 5,
          creativity: 5,
          xp: 0,
          level: 1,
          streaks: 0,
          achievements: [],
          pendingAchievements: [],
          // Initialize AI credits (free tier)
          aiCredits: 5,
          // Initialize preferences
          preferences: {
            workloadLevel: 'medium',
            maxTasksPerDay: 4,
            workingDays: [1, 2, 3, 4, 5],
            preferredTaskDuration: 'medium'
          }
        })
      );

      if (createError) {
        logError("signup:createUser", createError);
        return {
          success: false,
          message: "Could not create user. Please try again.",
        };
      }

      // Send verification email (queued)
      const verificationCode = MakeID(6);
      const expiry = DateTime.now().plus({ minutes: 30 }).toISO();

      await EmailQueue.create({
        toEmail: email,
        subject: "Verify Your Shard Account",
        message: `Your verification code is: ${verificationCode}. It expires in 30 minutes.`,
      });

      // Save verification code to user (you might want a separate table for this)
      // For now, we'll use verificationToken field
      await User.findByIdAndUpdate(newUser._id, {
        verificationToken: verificationCode,
      });

      SaveAuditTrail({
        userId: newUser._id.toString(),
        task: "Signed up",
        details: `New user signed up with email ${email}`,
      });

      return {
        success: true,
        message: "Account created successfully. Please check your email for verification code.",
        user: {
          id: newUser._id.toString(),
          email: newUser.email,
          username: newUser.username,
          profilePic: newUser.profilePic,
          role: newUser.role,
          authProvider: newUser.authProvider,
        },
      };
    },

    // Login with password
    async login(_, { email, password }) {
      if (!email || !password) {
        return {
          success: false,
          message: "Email and password are required.",
        };
      }

      const [error, user] = await catchError(
        User.findOne({ email: email.toLowerCase() }).lean()
      );

      if (error) {
        logError("login", error);
        return {
          success: false,
          message: "An error occurred. Please check your credentials and try again.",
        };
      }

      if (!user) {
        // Don't reveal if user exists
        return {
          success: false,
          message: "Invalid email or password.",
        };
      }

      if (!user.isActive) {
        return {
          success: false,
          message: "Your account has been deactivated. Please contact support.",
        };
      }

      // Verify password
      const isPasswordValid = await comparePassword(password, user.passwordHash);
      if (!isPasswordValid) {
        return {
          success: false,
          message: "Invalid email or password.",
        };
      }

      // Update last login
      await User.findByIdAndUpdate(user._id, {
        lastLoginAt: new Date(),
      });

      // Generate tokens
      const tokens = await setJWT(user._id.toString());

      SaveAuditTrail({
        userId: user._id.toString(),
        task: "Logged in",
        details: "User logged in successfully",
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
          emailVerified: user.emailVerified,
        },
      };
    },

    // Passwordless login - send code
    async requestLoginCode(_, { email }) {
      const [error, user] = await catchError(
        User.findOne({ email: email.toLowerCase() }, "username email").lean()
      );

      if (error) {
        logError("requestLoginCode", error);
        return {
          success: false,
          message: "An error occurred. Please try again.",
        };
      }

      if (!user) {
        // Don't reveal if user exists
        return {
          success: true,
          message: "If an account exists with this email, a code has been sent.",
        };
      }

      if (!user.isActive) {
        return {
          success: false,
          message: "Your account has been deactivated. Please contact support.",
        };
      }

      const code = MakeID(6);
      const expiry = DateTime.now()
        .plus({ minutes: +(process.env.LOGIN_CODE_EXPIRES_IN || 10) })
        .toISO();

      // Store code temporarily (you might want a separate table for this)
      // For now, using verificationToken field temporarily
      await User.findOneAndUpdate(
        { email: email.toLowerCase() },
        {
          verificationToken: code,
          passwordResetExpires: expiry,
        }
      );

      // Queue email
      await EmailQueue.create({
        toEmail: email,
        subject: "Your Shard Login Code",
        message: `Your login code is: ${code}. This code expires in ${process.env.LOGIN_CODE_EXPIRES_IN || 10} minutes.`,
      });

      return {
        success: true,
        message: "A login code has been sent to your email.",
      };
    },

    // Verify login code
    async verifyLoginCode(_, { email, code }) {
      if (!email || !code) {
        return {
          success: false,
          message: "Email and code are required.",
        };
      }

      const [error, user] = await catchError(
        User.findOne({
          email: email.toLowerCase(),
          verificationToken: code,
        }).lean()
      );

      if (error) {
        logError("verifyLoginCode", error);
        return {
          success: false,
          message: "An error occurred. Please try again.",
        };
      }

      if (!user) {
        return {
          success: false,
          message: "Invalid or expired login code.",
        };
      }

      // Check if code has expired
      if (user.passwordResetExpires && new Date(user.passwordResetExpires) < new Date()) {
        return {
          success: false,
          message: "Login code has expired. Please request a new one.",
        };
      }

      // Clear verification token
      await User.findByIdAndUpdate(user._id, {
        verificationToken: undefined,
        passwordResetExpires: undefined,
        lastLoginAt: new Date(),
      });

      // Generate tokens
      const tokens = await setJWT(user._id.toString());

      SaveAuditTrail({
        userId: user._id.toString(),
        task: "Logged in",
        details: "User logged in successfully via passwordless code",
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
        },
      };
    },

    // Logout
    async logout(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Remove the refresh token from user's array
      // This would require tracking which specific token to remove
      // For now, we'll just log the logout

      SaveAuditTrail({
        userId: context.id,
        task: "Logged out",
        details: "User logged out",
      });

      return {
        success: true,
        message: "Logged out successfully.",
      };
    },

    // Update profile
    async updateProfile(_, { input }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Moderate public-facing profile fields
      if (input.username) {
        const usernameMod = moderate(input.username, 'public_profile');
        if (!usernameMod.allowed)
          return { success: false, message: usernameMod.reason || 'Username is not allowed.' };
      }
      if (input.bio) {
        const bioMod = moderate(input.bio, 'public_profile');
        if (!bioMod.allowed)
          return { success: false, message: bioMod.crisisMessage || bioMod.reason || 'Bio content is not allowed.' };
      }

      const updateData: any = {};
      if (input.username) updateData.username = input.username;
      if (input.bio !== undefined) updateData.bio = input.bio;
      if (input.profilePic) updateData.profilePic = input.profilePic;
      if (input.timezone) updateData.timezone = input.timezone;
      if (input.birthdate !== undefined) {
        updateData.birthdate = input.birthdate ? new Date(input.birthdate) : null;
      }

      const [updateError, updatedUser] = await catchError(
        User.findByIdAndUpdate(context.id, updateData, { new: true }).lean()
      );

      if (updateError) {
        logError("updateProfile", updateError);
        return {
          success: false,
          message: "Could not update profile.",
        };
      }

      // Invalidate user cache
      await cacheInvalidate.user(context.id);

      SaveAuditTrail({
        userId: context.id,
        task: "Updated profile",
        details: "User updated their profile",
      });

      return {
        success: true,
        message: "Profile updated successfully.",
        user: {
          id: updatedUser._id.toString(),
          email: updatedUser.email,
          username: updatedUser.username,
          bio: updatedUser.bio,
          profilePic: updatedUser.profilePic,
          birthdate: updatedUser.birthdate ? (updatedUser.birthdate as Date).toISOString() : null,
          timezone: updatedUser.timezone || 'UTC',
        },
      };
    },

    // Change password
    async changePassword(_, { currentPassword, newPassword }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Validate new password
      if (!validatePassword(newPassword)) {
        return {
          success: false,
          message: "New password must be at least 8 characters with uppercase, lowercase, and number.",
        };
      }

      const [error, user] = await catchError(
        User.findById(context.id)
      );

      if (error || !user) {
        return {
          success: false,
          message: "User not found.",
        };
      }

      // Verify current password
      const isPasswordValid = await comparePassword(currentPassword, user.passwordHash);
      if (!isPasswordValid) {
        return {
          success: false,
          message: "Current password is incorrect.",
        };
      }

      // Hash new password
      const newPasswordHash = await hashPassword(newPassword);

      await User.findByIdAndUpdate(context.id, {
        passwordHash: newPasswordHash,
      });

      SaveAuditTrail({
        userId: context.id,
        task: "Changed password",
        details: "User changed their password",
      });

      return {
        success: true,
        message: "Password changed successfully.",
      };
    },

    // Update profile picture with Cloudinary URL
    async updateProfilePicture(_, { cloudinaryUrl }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      // Validate Cloudinary URL format
      const cloudinaryRegex = /^https:\/\/res\.cloudinary\.com\/[^\/]+\/image\/upload\/.+/;
      if (!cloudinaryUrl || !cloudinaryRegex.test(cloudinaryUrl)) {
        return {
          success: false,
          message: "Invalid Cloudinary URL format.",
        };
      }

      const [updateError, updatedUser] = await catchError(
        User.findByIdAndUpdate(context.id, { profilePic: cloudinaryUrl }, { new: true }).lean()
      );

      if (updateError) {
        logError("updateProfilePicture", updateError);
        return {
          success: false,
          message: "Could not update profile picture.",
        };
      }

      SaveAuditTrail({
        userId: context.id,
        task: "Updated profile picture",
        details: "User updated their profile picture",
      });

      return {
        success: true,
        message: "Profile picture updated successfully.",
        profilePic: updatedUser.profilePic,
      };
    },

    // Update user preferences
    async updatePreferences(_, { input }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      const [updateError, updatedUser] = await catchError(
        User.findByIdAndUpdate(
          context.id,
          { preferences: input },
          { new: true }
        ).lean()
      );

      if (updateError) {
        logError("updatePreferences", updateError);
        return {
          success: false,
          message: "Could not update preferences.",
        };
      }

      // Invalidate user cache
      await cacheInvalidate.user(context.id);

      SaveAuditTrail({
        userId: context.id,
        task: "Updated preferences",
        details: `Workload: ${input.workloadLevel}, Max tasks: ${input.maxTasksPerDay}/day`,
      });

      return {
        success: true,
        message: "Preferences updated successfully.",
      };
    },

    /**
     * Google Sign-In/Sign-Up
     * Handles both new and existing users authenticating with Google
     * @param _ - Parent resolver
     * @param idToken - Google ID token from the client
     * @returns Authentication response with tokens and user data
     */
    async googleSignIn(_, { idToken }) {
      try {
        // Input validation
        if (!idToken || typeof idToken !== 'string') {
          return {
            success: false,
            message: 'A valid Google ID token is required.',
            code: 'INVALID_TOKEN',
          };
        }
        // Verify Google token
        const googleUser = await verifyGoogleToken(idToken);
        if (!googleUser || !googleUser.email) {
          return {
            success: false,
            message: 'Invalid Google user data received.',
            code: 'INVALID_GOOGLE_USER',
          };
        }

        // Check if user exists by Google ID or email
        const [existingError, existingUser] = await catchError(
          User.findOne({
            $or: [
              { googleId: googleUser.googleId },
              { email: googleUser.email.toLowerCase() }
            ]
          }).lean()
        );

        if (existingError) {
          logError('googleSignIn:findUser', existingError);
          throw new Error('Failed to check existing user');
        }

        console.log("existingUser", existingUser);

        let user;
        let isNewUser = false;

        if (existingUser) {
          // Existing user - update Google ID if missing
          const updates: Record<string, any> = {
            lastLoginAt: new Date(),
          };

          if (!existingUser.googleId) {
            updates.googleId = googleUser.googleId;
            updates.authProvider = 'google';
            updates.emailVerified = true; // Trust Google's email verification
          }

          // Update profile picture if not set or if it's a default avatar
          const hasDefaultAvatar = existingUser.profilePic?.includes('ui-avatars.com');
          if (!existingUser.profilePic || hasDefaultAvatar) {
            updates.profilePic = googleUser.picture || updates.profilePic;
          }

          await User.findByIdAndUpdate(existingUser._id, updates);
          user = { ...existingUser, ...updates };
        } else {
          // New user - create account
          const username = generateUsernameFromGoogle(googleUser.email, googleUser.name);
          console.log("username", username);
          
          const newUserData = {
            email: googleUser.email.toLowerCase(),
            emailHash: createHash('sha256').update(googleUser.email.toLowerCase()).digest('hex'),
            username,
            googleId: googleUser.googleId,
            profilePic: googleUser.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(googleUser.name || username)}&background=667eea&color=fff&size=150`,
            authProvider: 'google',
            emailVerified: true, // Google verifies emails
            role: 'user',
            isActive: true,
            // Initialize RPG stats with default values
            strength: 5,
            intelligence: 5,
            charisma: 5,
            endurance: 5,
            creativity: 5,
            xp: 0,
            level: 1,
            streaks: 0,
            achievements: [],
            pendingAchievements: [],
          };

          const [createError, newUser] = await catchError(User.create(newUserData));

          if (createError || !newUser) {
            logError('googleSignIn:createUser', createError);
            throw new Error('Failed to create new user account');
          }
console.log("newUser", newUser);

          user = newUser;
          isNewUser = true;

          SaveAuditTrail({
            userId: user._id.toString(),
            task: 'Signed up with Google',
            details: `New user signed up with Google: ${googleUser.email}`,
          });
        }

        // Generate authentication tokens
        const tokens = await setJWT(user._id.toString());
        if (!tokens) {
          throw new Error('Failed to generate authentication tokens');
        }
        console.log("tokens");
        

        // Update last login for existing users
        if (!isNewUser) {
          
          await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });
          console.log("lastLoginAt");
          
        }

        SaveAuditTrail({
          userId: user._id.toString(),
          task: 'Logged in with Google',
          details: 'User logged in via Google Sign-In',
        });

        console.log("audit done");
        

        // Prepare user data for response
        const userResponse = {
          id: user._id.toString(),
          email: user.email,
          username: user.username,
          profilePic: user.profilePic,
          role: user.role,
          emailVerified: user.emailVerified,
          authProvider: user.authProvider || 'google',
          isNewUser,
          pendingAchievements: user.pendingAchievements || [],
        };

        console.log("userResponse", userResponse);
        

        return {
          success: true,
          message: isNewUser ? 'Account created successfully' : 'Login successful',
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          user: userResponse,
        };
      } catch (error) {
        logError('googleSignIn', error);
        return {
          success: false,
          message: error.message || 'Authentication failed. Please try again.',
          code: error.code || 'AUTH_ERROR',
        };
      }
    },
  },

  Query: {
    // Get current user (with caching)
    async currentUser(_, __, context) {
      if (!context.id) {
        return {
          success: false,
          message: "Please login to continue.",
        };
      }

      // Use cached user data
      const user = await cache.getOrSet(
        cacheKeys.user(context.id),
        async () => {
          const [error, userData] = await catchError(
            User.findById(context.id)
              .select("email username bio profilePic role emailVerified xp level achievements pendingAchievements strength intelligence charisma endurance creativity authProvider")
              .lean()
          );

          if (error || !userData) {
            throw new Error("User not found");
          }

          return userData;
        },
        1800 // 30 minutes cache
      );

      return {
        success: true,
        message: "User profile fetched successfully.",
        user: {
          id: context.id,
          email: user.email,
          username: user.username,
          bio: user.bio,
          profilePic: user.profilePic,
          role: user.role,
          emailVerified: user.emailVerified,
          xp: user.xp,
          level: user.level,
          achievements: user.achievements || [],
          strength: user.strength,
          intelligence: user.intelligence,
          charisma: user.charisma,
          endurance: user.endurance,
          creativity: user.creativity,
          authProvider: user.authProvider,
          pendingAchievements: user.pendingAchievements || [],
        },
      };
    },

    // Verify if username is available
    async checkUsername(_, { username }) {
      const [error, user] = await catchError(
        User.findOne({ username }).lean()
      );

      if (error) {
        logError("checkUsername", error);
        return {
          success: false,
          available: false,
        };
      }

      return {
        success: true,
        available: !user,
      };
    },

    // Search users by username or email/phone hash
    async searchUsers(_, { query, type }, context) {
      if (!context.id) ThrowError("Please login to continue.");

      if (!query || query.trim().length < 2) {
        return { success: true, users: [] };
      }

      // Get IDs of blocked users to exclude
      const [blockedErr, blocked] = await catchError(
        Friendship.find({ user: context.id, status: "blocked" }).select("friend").lean()
      );
      const blockedIds = (blocked || []).map((b: any) => b.friend.toString());
      blockedIds.push(context.id); // exclude self

      let dbQuery: any = { _id: { $nin: blockedIds }, isActive: true };

      if (!type || type === "USERNAME") {
        dbQuery.username = { $regex: query.trim(), $options: "i" };
      } else if (type === "EMAIL_HASH") {
        dbQuery.emailHash = query.trim();
      } else if (type === "PHONE_HASH") {
        dbQuery.phoneHash = query.trim();
      }

      const [searchErr, users] = await catchError(
        User.find(dbQuery)
          .select("username profilePic")
          .limit(20)
          .lean()
      );

      if (searchErr) {
        logError("searchUsers", searchErr);
        return { success: false, users: [] };
      }

      // Enrich with mutual friend count
      const [friendsErr, myFriendships] = await catchError(
        Friendship.find({ user: context.id, status: "accepted" }).select("friend").lean()
      );
      const myFriendIds = new Set((myFriendships || []).map((f: any) => f.friend.toString()));

      const results = await Promise.all(
        (users || []).map(async (u: any) => {
          const [, mutuals] = await catchError(
            Friendship.countDocuments({
              user: { $in: [...myFriendIds] },
              friend: u._id.toString(),
              status: "accepted",
            })
          );
          return {
            id: u._id.toString(),
            username: u.username,
            profilePic: u.profilePic,
            mutualFriends: mutuals || 0,
          };
        })
      );

      return { success: true, users: results };
    },

    // Get Cloudinary signed upload URL for profile picture
    async getSignedUploadUrl(_, __, context) {
      if (!context.id) ThrowError("Please login to continue.");

      try {
        const uploadParams = getCloudinarySignedUpload("shard-server/profile-pics");
        
        return {
          success: true,
          message: "Upload URL generated successfully.",
          uploadUrl: `https://api.cloudinary.com/v1_1/${uploadParams.cloudName}/image/upload`,
          params: {
            apiKey: uploadParams.apiKey,
            timestamp: uploadParams.timestamp,
            publicId: uploadParams.publicId,
            signature: uploadParams.signature,
            folder: uploadParams.folder,
          },
        };
      } catch (error) {
        logError("getSignedUploadUrl", error);
        return {
          success: false,
          message: "Failed to generate upload URL.",
        };
      }
    },

    /**
     * Public: returns the current offerings from the DB for the mobile paywall.
     * No auth required so any logged-in user can see prices.
     */
    async listOfferings() {
      const { default: Offering } = await import("../../models/Offering.js");
      const offerings = await Offering.find({}).lean();
      return offerings;
    },
  },
};

