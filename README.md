# Shard Server

Backend for **Shard** — a productivity app that turns goals into game-like quests with XP, streaks, and social accountability.

## Tech Stack

- **Runtime:** Node.js (ES2023, ESM)
- **API:** Apollo Server v5 + Express 5 (GraphQL)
- **Real-time:** Socket.IO (WebSockets for chat & presence)
- **Database:** MongoDB Atlas (Mongoose ODM)
- **Auth:** Google OAuth2, JWT (access + refresh tokens), bcrypt
- **AI:** Groq SDK (quest breakdown / task generation)
- **Push Notifications:** Firebase Cloud Messaging
- **Media:** Cloudinary (avatar/image uploads)
- **Cron:** node-cron (overdue tasks, deadline reminders, purges)

## Project Structure

```
src/
├── index.ts                 # Entry point — Apollo, Express, WS, cron setup
├── config/
│   └── db.ts                # MongoDB connection
├── middleware/
│   ├── CreateContext.ts      # GraphQL context (auth, user injection)
│   └── FormatError.ts       # Error formatting
├── schema/
│   ├── Typedefinitions.ts    # GraphQL type definitions
│   ├── Resolvers.ts          # Resolver barrel (merges all resolver modules)
│   └── resolvers/
│       ├── User.ts           # Auth, profile, registration
│       ├── Shard.ts          # Quests (CRUD, AI breakdown, progress)
│       ├── Chat.ts           # Messaging (direct + shard group chats)
│       ├── Friendship.ts     # Friend requests, blocking, suggestions
│       ├── Challenge.ts      # Challenges between friends
│       ├── SideQuest.ts      # Side quests (bonus goals)
│       ├── XP.ts             # XP/leveling system
│       ├── Analytics.ts      # User analytics & stats
│       ├── Notifications.ts  # In-app notifications
│       ├── PushNotifications.ts
│       ├── Report.ts         # Content reporting
│       └── Support.ts        # Support tickets
├── models/                   # Mongoose schemas (19 models)
├── Helpers/
│   ├── AIHelper.ts           # Groq AI integration
│   ├── GoogleAuth.ts         # Google token verification
│   ├── Cache.ts              # Redis/IORedis caching
│   ├── CronJobs.ts           # Scheduled tasks
│   ├── FirebaseMessaging.ts  # Push notification delivery
│   ├── Cloudinary.ts         # Image upload
│   ├── StreakHelper.ts       # Streak calculation logic
│   ├── setJWT.ts             # Token generation
│   ├── Validate.ts           # Input validation
│   └── ...
└── server/
    └── WebSocketServer.ts    # Socket.IO setup
```

## Setup

### Prerequisites

- Node.js 18+
- MongoDB Atlas cluster (or local MongoDB)
- Firebase project (for push notifications)
- Google Cloud OAuth2 credentials

### Environment Variables

Create a `.env` file in the project root:

```env
MONGO_URI=mongodb+srv://...
JWT_ACCESS_TOKEN_SECRET=...
JWT_REFRESH_TOKEN_SECRET=...
JWT_ACCESS_TOKEN_EXPIRES_IN=15
JWT_REFRESH_TOKEN_EXPIRES_IN=300
GOOGLE_CLIENT_ID=<web-client-id>
GOOGLE_ANDROID_CLIENT_ID=<android-client-id>
GROQ_API_KEY=...
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
FIREBASE_SERVICE_ACCOUNT_PATH=./src/server/<firebase-key>.json
```

### Install & Run

```bash
npm install

# Development (auto-reload with nodemon)
npm run dev

# Production
npm run build
npm start
```

### Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with nodemon (watches `src/`, rebuilds on change) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output (`dist/index.js`) |
| `npm run tunnel` | Expose local server via Cloudflare tunnel |

## API

- **GraphQL endpoint:** `http://localhost:4000/graphql`
- **WebSocket endpoint:** `ws://localhost:4000`

All queries and mutations require a JWT `Authorization: Bearer <token>` header except `login`, `register`, and `googleSignIn`.
# shard-server
