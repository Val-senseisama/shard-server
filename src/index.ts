import dotenv from "dotenv";
dotenv.config();
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import express from "express";
import http from "http";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import depthLimit from "graphql-depth-limit";
import { connectDB } from "./config/db.js";
import createContext from "./middleware/CreateContext.js";
import { formatError } from "./middleware/FormatError.js";
import typeDefs from "./schema/Typedefinitions.js";
import resolvers from "./schema/Resolvers.js";
import cors from "cors";
import { setupWebSocketServer } from "./server/WebSocketServer.js";
import {
  startOverdueTaskReschedule,
  startDeletedTaskPurge,
  startDeadlineReminders,
  startOverdueAlerts,
  startDailyTaskReminders,
  startScheduledNotificationDispatcher,
  startInactivityNudger,
  startStreakEventDetector,
} from './Helpers/CronJobs.js';
import { handleRevenueCatWebhook } from "./controllers/WebhookController.js";

const PORT = process.env.PORT || 4000;
const isProd = process.env.NODE_ENV === "production";

const app = express();
const httpServer = http.createServer(app);

// ─── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false, // Allow Apollo Studio in dev
  contentSecurityPolicy: isProd ? undefined : false,
}));

// ─── Body size limits ────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: isProd
    ? (origin, cb) => {
        // Mobile apps have no origin — allow. Web origins must be allowlisted.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
        else cb(new Error(`CORS: origin ${origin} not allowed`));
      }
    : true,
  exposedHeaders: ["x-access-token", "x-refresh-token"],
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Tight limit on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
});

// General GraphQL limit — prevents DoS via volume
const graphqlLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Slow down." },
  skip: (req) => {
    // Don't rate-limit health checks
    const body = req.body;
    return body?.operationName === "IntrospectionQuery";
  },
});

// ─── Webhook (before GraphQL middleware) ─────────────────────────────────────
app.post("/webhooks/revenuecat", handleRevenueCatWebhook);

// ─── WebSocket ────────────────────────────────────────────────────────────────
const io = setupWebSocketServer(httpServer);
import { setSocketIO } from "./schema/resolvers/Chat.js";
setSocketIO(io);
export { io };

// ─── Apollo Server ────────────────────────────────────────────────────────────
const server = new ApolloServer({
  typeDefs,
  resolvers,
  formatError,
  introspection: !isProd, // Disable schema exposure in production
  validationRules: [
    depthLimit(10), // Reject queries nested deeper than 10 levels
  ],
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
});

await server.start();

app.use(
  "/graphql",
  graphqlLimiter,
  expressMiddleware(server, {
    context: async ({ req, res }) => createContext(req, res),
  })
);

// ─── Separate stricter rate limit for auth operations (applied in resolvers) ──
// The auth resolvers themselves check a per-IP counter via this exported limiter.
export { authLimiter };

connectDB();

httpServer.listen(PORT, () => {
  console.log(`🚀 [SERVER] Running on port ${PORT} (${isProd ? "production" : "development"})`);
  startOverdueTaskReschedule();
  startDeletedTaskPurge();
  startDeadlineReminders();
  startOverdueAlerts();
  startDailyTaskReminders();
  startScheduledNotificationDispatcher();
  startInactivityNudger();
  startStreakEventDetector();
});
