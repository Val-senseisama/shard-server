import { connectDB } from "./config/db.js";
import { User } from "./models/User.js";
import { hashPassword } from "./Helpers/PasswordHash.js";
import mongoose from "mongoose";

const seedUsers = async () => {
  try {
    await connectDB();

    const usersToSeed = [
      {
        username: "google_tester",
        email: "google-test@shard.app",
        password: "ShardTest2024!",
        role: "pro",
        subscriptionTier: "pro",
        emailVerified: true,
      },
      {
        username: "demo_admin",
        email: "admin@shard.app",
        password: "AdminPass123!",
        role: "admin",
        subscriptionTier: "pro",
        emailVerified: true,
      },
      {
        username: "demo_user",
        email: "demo@shard.app",
        password: "DemoUser123!",
        role: "user",
        subscriptionTier: "free",
        emailVerified: true,
      },
    ];

    for (const userData of usersToSeed) {
      const existingUser = await User.findOne({ 
        $or: [{ email: userData.email }, { username: userData.username }] 
      });

      if (existingUser) {
        console.log(`⚠️ User ${userData.username} (${userData.email}) already exists. Skipping.`);
        continue;
      }

      const hashedPassword = await hashPassword(userData.password);
      
      const newUser = new User({
        username: userData.username,
        email: userData.email,
        passwordHash: hashedPassword,
        role: userData.role,
        subscriptionTier: userData.subscriptionTier,
        emailVerified: userData.emailVerified,
        authProvider: "email",
        isActive: true,
        xp: 100,
        level: 5,
        aiCredits: 1000,
        preferences: {
          workloadLevel: 'medium',
          maxTasksPerDay: 5,
          workingDays: [1, 2, 3, 4, 5],
          preferredTaskDuration: 'medium'
        }
      });

      await newUser.save();
      console.log(`✅ Created user: ${userData.username}`);
    }

    console.log("🚀 Seeding completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  }
};

seedUsers();
