import mongoose, { Schema, Document } from "mongoose";

// Define the TypeScript interface for User
export interface IUser extends Document {
  username: string;
  email: string;
  passwordHash?: string; // Optional for OAuth users
  profilePic?: string; // Cloudinary URL or Google profile pic
  bio?: string;
  
  // OAuth fields
  googleId?: string;
  authProvider: "email" | "google";

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
  level: number;
  streaks: number; // Legacy field - kept for backward compatibility
  
  // Streak System (new detailed tracking)
  currentStreak: number;
  longestStreak: number;
  lastCompletionDate?: Date;

  subscriptionTier: 'free' | 'pro';

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
      enum: ["email", "google"],
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
        default: 500
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
UserSchema.index({ email: 1 }, { unique: true }); // Already unique, but explicit index helps
UserSchema.index({ username: 1 }, { unique: true }); // Already unique, but explicit index helps
UserSchema.index({ emailVerified: 1 });
UserSchema.index({ isActive: 1 });
UserSchema.index({ role: 1 });
UserSchema.index({ "refreshTokens.0": 1 }); // Index on array element (useful for querying users with tokens)

// Export the model
export const User = mongoose.model<IUser>("User", UserSchema);
