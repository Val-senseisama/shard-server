import mongoose, { Schema, Document, Types } from "mongoose";

// Define the TypeScript interface for User
export interface IUser extends Document {
  username: string;
  email: string;
  passwordHash?: string; // Optional for OAuth users
  profilePic?: string; // Cloudinary URL or Google profile pic
  bio?: string;
  
  // OAuth fields
  googleId?: string;
  authProvider: "email" | "google" | "password";

  // Authentication & Security
  refreshTokens: string[];
  emailVerified: boolean;
  verificationToken?: string;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  
  // User status
  role: "admin" | "user" | "pro";
  isActive: boolean;
  lastLoginAt?: Date;
  lastActive?: Date;

  // Achievements
  achievements: string[]; // Earned achievement IDs
  pendingAchievements: string[]; // New achievements to be shown

  // RPG-style stats
  strength: number;
  intelligence: number;
  charisma: number;
  endurance: number;
  creativity: number;

  // Progression
  xp: number;
  aiCredits: number;
  trialStartedAt?: Date;
  /** Outer bound of the trial — see TRIAL_MAX_DAYS in Helpers/Entitlements.ts. */
  trialEndsAt?: Date;
  /**
   * When the user finished their FIRST quest. This is the milestone that ends the
   * Pro trial: the payoff of this product takes weeks, so a flat countdown asked
   * people to convert before they had any evidence it worked. Ending the trial at
   * the moment of proof puts the paywall where the motivation is.
   */
  firstQuestCompletedAt?: Date;
  /**
   * First completed mini-goal — the activation milestone. Proof that a generated
   * plan actually got followed, which is the product's whole thesis.
   */
  firstMiniGoalCompletedAt?: Date;
  trialReminderSent?: boolean;
  // Referral loop
  referralCode?: string;
  referredBy?: Types.ObjectId;
  referralCount: number;
  level: number;
  streaks: number; // Legacy field - kept for backward compatibility
  
  // Streak System — written ONLY by Helpers/Streak.ts
  currentStreak: number;
  longestStreak: number;
  lastCompletionDate?: Date;
  /**
   * `YYYY-MM-DD` of the last qualifying activity, in the user's OWN timezone.
   * This — not `lastCompletionDate` — is the streak's notion of "a day", so a
   * 9pm completion in UTC-8 counts for the day the user thinks it is.
   */
  lastStreakDayKey?: string;
  /**
   * The last day a *spent freeze* covers, kept separate from
   * `lastStreakDayKey` so a freeze never forges activity. A freeze covers one
   * isolated missed day and does not stack — see Helpers/Streak.ts.
   */
  freezeCoveredThrough?: string;
  streakFreezeTokens: number;
  lastFreezeUsedAt?: Date;
  comebackBonusUntil?: Date;
  /** The streak that was lost. Written once, at the break — see Streak.ts. */
  previousStreak: number;
  /** When the streak broke; bounds the repair window. */
  streakBrokenAt?: Date;
  streakNudgeSentAt?: Date;

  subscriptionTier: 'free' | 'pro' | 'enterprise';

  birthdate?: Date;
  timezone?: string;

  // Workload Preferences
  preferences: {
    workloadLevel: 'light' | 'medium' | 'aggressive';
    maxTasksPerDay: number;
    workingDays: number[]; // [1,2,3,4,5] = Mon-Fri
    preferredTaskDuration: 'short' | 'medium' | 'long';
  };

  // Search hashes
  emailHash?: string;
  phoneHash?: string;

  // Push Notifications
  pushTokens: {
    token: string;
    platform: 'ios' | 'android' | 'web';
    deviceId?: string;
    registeredAt: Date;
    lastUsed: Date;
  }[];

  createdAt: Date;
  updatedAt: Date;
}

// Define the Mongoose schema
const UserSchema: Schema<IUser> = new Schema(
  {
    username: { 
        type: String, 
        required: true, 
        unique: true,
         trim: true
         },
    email: { 
        type: String,
         required: true, 
         unique: true, 
         lowercase: true 
        },
    passwordHash: {
         type: String, 
         required: false // Optional for OAuth users
        },
    
    // OAuth fields
    googleId: {
      type: String,
      unique: true,
      sparse: true, // Allow multiple null values
    },
    authProvider: {
      type: String,
      enum: ["email", "google", "password"],
      default: "email",
    },

    profilePic: {
         type: String,
         // Cloudinary URL will be stored here
         // Format: https://res.cloudinary.com/{cloud_name}/image/upload/{path}
         // Default avatar URL generated on signup
        },
    bio: { 
        type: String, 
        maxlength: 280 
    },

    // Authentication & Security
    refreshTokens: {
      type: [String],
      default: []
    },
    emailVerified: {
      type: Boolean,
      default: false
    },
    verificationToken: String,
    passwordResetToken: String,
    passwordResetExpires: Date,

    // User status
    subscriptionTier: {
      type: String,
      enum: ['free', 'pro', 'enterprise'],
      default: 'free'
    },
    role: {
      type: String,
      enum: ["admin", "user", "pro"],
      default: "user"
    },
    isActive: {
      type: Boolean,
      default: true
    },
    lastLoginAt: Date,
    lastActive: Date,

    birthdate: { type: Date },
    timezone: { type: String, default: 'UTC' },

    // Search hashes (SHA-256 of lowercased email / phone)
    emailHash: { type: String, sparse: true, index: true },
    phoneHash: { type: String, sparse: true, index: true },

    // RPG stats
    strength: { 
        type: Number, 
        default: 5 
    },
    intelligence: { 
        type: Number,
         default: 5 
        },
    charisma: { 
        type: Number,
         default: 5 
        },
    endurance: { 
        type: Number, 
        default: 5 
    },
    creativity: { 
        type: Number,
         default: 5
         },

    // Progression
    xp: { 
        type: Number, 
        default: 0 
    },
    aiCredits: {
        type: Number,
        // Keep in sync with FREE_MONTHLY_CREDITS in Helpers/Entitlements.ts.
        // Hardcoded (not imported) to avoid a circular import at model-eval time.
        default: 15
    },
    // 7-day Pro trial granted at signup. Entitlement is computed on read
    // (trialEndsAt > now) in Helpers/Entitlements.ts — no expiry cron needed.
    trialStartedAt: {
        type: Date
    },
    trialEndsAt: {
        type: Date
    },
    firstQuestCompletedAt: {
        type: Date
    },
    firstMiniGoalCompletedAt: {
        type: Date
    },
    // Set once when the "trial ending soon" reminder is sent (idempotency).
    trialReminderSent: {
        type: Boolean,
        default: false
    },
    // Referral loop
    referralCode: {
        type: String,
        unique: true,
        sparse: true
    },
    referredBy: {
        type: Schema.Types.ObjectId,
        ref: "User"
    },
    referralCount: {
        type: Number,
        default: 0
    },
    level: { 
        type: Number,
         default: 1 
        },
    streaks: { 
        type: Number, 
        default: 0 
    },

    // Detailed Streak System
    currentStreak: {
      type: Number,
      default: 0
    },
    longestStreak: {
      type: Number,
      default: 0
    },
    lastCompletionDate: Date,
    lastStreakDayKey: { type: String },
    freezeCoveredThrough: { type: String },
    streakFreezeTokens: { type: Number, default: 1 },
    lastFreezeUsedAt: Date,
    comebackBonusUntil: Date,
    previousStreak: { type: Number, default: 0 },
    streakBrokenAt: Date,
    streakNudgeSentAt: Date,

    achievements: {
         type: [String],
          default: [] 
    },
    pendingAchievements: {
      type: [String],
      default: []
    },

    // Workload Preferences
    preferences: {
      type: {
        workloadLevel: {
          type: String,
          enum: ['light', 'medium', 'aggressive'],
          default: 'medium'
        },
        maxTasksPerDay: {
          type: Number,
          default: 4,
          min: 1,
          max: 10
        },
        workingDays: {
          type: [Number],
          default: [1, 2, 3, 4, 5], // Monday-Friday
          validate: {
            validator: function(days: number[]) {
              return days.every(d => d >= 0 && d <= 6);
            },
            message: 'Working days must be 0-6 (Sunday-Saturday)'
          }
        },
        preferredTaskDuration: {
          type: String,
          enum: ['short', 'medium', 'long'],
          default: 'medium'
        }
      },
      default: {
        workloadLevel: 'medium',
        maxTasksPerDay: 4,
        workingDays: [1, 2, 3, 4, 5],
        preferredTaskDuration: 'medium'
      }
    },

    // Push Notifications - FCM tokens
    pushTokens: {
      type: [{
        token: {
          type: String,
          required: true
        },
        platform: {
          type: String,
          enum: ['ios', 'android', 'web'],
          required: true
        },
        deviceId: String,
        registeredAt: {
          type: Date,
          default: Date.now
        },
        lastUsed: {
          type: Date,
          default: Date.now
        }
      }],
      default: []
    },
  },
  {
    timestamps: true, // auto add createdAt & updatedAt
  }
);

// Add indexes for common queries
UserSchema.index({ emailVerified: 1 });
UserSchema.index({ isActive: 1 });
UserSchema.index({ role: 1 });
UserSchema.index({ "refreshTokens.0": 1 }); // Index on array element (useful for querying users with tokens)
// Local-hour cron buckets select users by timezone every hour — keep it cheap.
UserSchema.index({ timezone: 1 });
// Dormant/winback campaigns scan on last activity.
UserSchema.index({ lastActive: 1 });
// Activation cohorts are selected by signup date.
UserSchema.index({ createdAt: 1 });
// The global leaderboard both sorts on xp and counts how many users are ahead
// of you. Without this it is two collection scans per call.
UserSchema.index({ xp: -1 });

// Export the model
export const User = mongoose.model<IUser>("User", UserSchema);
