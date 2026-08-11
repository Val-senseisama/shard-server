import dotenv from "dotenv";
dotenv.config();
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import express from "express";
import http from "http";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import depthLimit from "graphql-depth-limit";
import { connectDB } from "./config/db.js";
import createContext from "./middleware/CreateContext.js";
import { formatError } from "./middleware/FormatError.js";
import typeDefs from "./schema/Typedefinitions.js";
import resolvers from "./schema/Resolvers.js";
import cors from "cors";
import mongoose from "mongoose";
import { createHash } from "crypto";
import { setupWebSocketServer } from "./server/WebSocketServer.js";
import { initScheduledJobs, closeScheduledJobs } from './Helpers/CronJobs.js';
import { closeChatQueue } from './Helpers/Queue.js';
import { closeCache } from './Helpers/Cache.js';
import { handleRevenueCatWebhook } from "./controllers/WebhookController.js";

const PORT = process.env.PORT || 4000;
const isProd = process.env.NODE_ENV === "production";

const app = express();
const httpServer = http.createServer(app);

// ─── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: isProd ? {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": [
        "'self'", 
        "'unsafe-inline'", 
        "https://apollo-server-landing-page.cdn.apollographql.com", 
        "https://embeddable-sandbox.cdn.apollographql.com", 
        "https://embeddable-explorer.cdn.apollographql.com"
      ],
      "img-src": [
        "'self'", 
        "data:", 
        "https://apollo-server-landing-page.cdn.apollographql.com"
      ],
      "frame-src": [
        "'self'", 
        "https://sandbox.embed.apollographql.com", 
        "https://embeddable-sandbox.cdn.apollographql.com"
      ],
    },
  } : false,
}));

// Trust Railway's reverse proxy so express-rate-limit reads the real client IP
if (isProd) app.set('trust proxy', 1);

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
  // Key authenticated traffic on the caller's own token rather than their IP.
  //
  // Mobile users sit behind carrier-grade NAT, where thousands of subscribers
  // share one egress address. Keying purely on IP put all of them in a single
  // 120/min bucket, so a busy cell tower would throttle unrelated users and
  // present as a random, unreproducible outage. Anonymous traffic still falls
  // back to IP, which is all we have for it.
  keyGenerator: (req) => {
    const token = req.headers["x-access-token"];
    if (typeof token === "string" && token.length > 0) {
      // Hashed so raw credentials never become rate-limiter map keys.
      return "t:" + createHash("sha256").update(token).digest("hex");
    }
    // ipKeyGenerator normalises IPv6 to its /64 prefix. Using req.ip raw would
    // let a single IPv6 client rotate addresses within its own subnet and get a
    // fresh bucket each time — express-rate-limit v8 refuses to start without it.
    return "ip:" + ipKeyGenerator(req.ip ?? "unknown");
  },
  skip: (req) => {
    // Don't rate-limit health checks
    const body = req.body;
    return body?.operationName === "IntrospectionQuery";
  },
});

// ─── Health check ─────────────────────────────────────────────────────────────
// Deliberately ahead of the rate limiters: a platform health probe must never be
// throttled, or a traffic spike gets misread as the process being down and the
// instance is cycled exactly when it is busiest.
//
// Reports unhealthy unless Mongo is actually connected. A process that is
// listening but cannot reach its database serves errors, and 200-on-listening
// would keep it in the load balancer doing that.
app.get("/healthz", (_req, res) => {
  console.log("Health called");
  
  const dbReady = mongoose.connection.readyState === 1;
  res.status(dbReady ? 200 : 503).json({
    status: dbReady ? "ok" : "degraded",
    db: mongoose.STATES[mongoose.connection.readyState],
    uptime: Math.round(process.uptime()),
  });
});

// ─── Webhook (before GraphQL middleware) ─────────────────────────────────────
app.post("/webhooks/revenuecat", handleRevenueCatWebhook);

// ─── Error Logging API ────────────────────────────────────────────────────────
// This is an unauthenticated write path into the database: it has to be rate
// limited and size capped, or one request with a 2MB body of array elements
// becomes tens of thousands of inserts.
import { logError } from "./Helpers/Helpers.js";

const MAX_ERRORS_PER_BATCH = 50;
const MAX_FIELD_LENGTH = 2000;

const clientLogLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many error reports." },
});

const truncate = (v: unknown, max = MAX_FIELD_LENGTH): string | undefined =>
  typeof v === "string" ? v.slice(0, max) : undefined;

app.post("/log-errors", clientLogLimiter, async (req, res) => {
  // Optional shared secret — enforced only when configured, so turning it on is
  // a deploy-order choice rather than a hard client dependency. Set
  // CLIENT_LOG_SECRET once the mobile client sends the header.
  const expectedSecret = process.env.CLIENT_LOG_SECRET;
  if (expectedSecret && req.headers["x-client-log-secret"] !== expectedSecret) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const { errors } = req.body;
  if (!Array.isArray(errors)) {
    return res.status(400).json({ success: false, message: "Invalid payload: 'errors' must be an array." });
  }

  if (errors.length > MAX_ERRORS_PER_BATCH) {
    return res.status(413).json({
      success: false,
      message: `Too many errors in one batch (max ${MAX_ERRORS_PER_BATCH}).`,
    });
  }

  try {
    for (const err of errors) {
      // Only trust userId if it looks like one — this field is attacker-controlled.
      const userId = mongoose.isValidObjectId(err?.userId) ? err.userId : undefined;

      await logError(truncate(err?.task) || "client-error", truncate(err?.error), {
        severity: ["low", "medium", "high", "critical"].includes(err?.severity)
          ? err.severity
          : "medium",
        userId,
        metadata: {
          client: "mobile",
          platform: truncate(err?.platform, 64),
          version: truncate(err?.version, 64),
          // Client metadata is arbitrary attacker-controlled JSON, so it is
          // flattened to a bounded string rather than spread into the document.
          details: err?.metadata ? truncate(JSON.stringify(err.metadata)) : undefined,
        },
      });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Error processing client logs:", error);
    res.status(500).json({ success: false });
  }
});

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
  // Introspection publishes the full schema — every type, field and mutation.
  // That is exactly what you want in development and a free map of the attack
  // surface in production, so it is now a deliberate switch rather than always
  // on. Set GRAPHQL_INTROSPECTION=true in the production environment to keep
  // using Sandbox/Explorer against it.
  introspection: !isProd || process.env.GRAPHQL_INTROSPECTION === "true",
  validationRules: [
    depthLimit(10), // Reject queries nested deeper than 10 levels
  ],
  // ApolloServerPluginDrainHttpServer is deliberately NOT used.
  //
  // Its only job is to close `httpServer` when `server.stop()` runs — which the
  // explicit shutdown sequence at the bottom of this file already does, in an
  // order that accounts for Socket.IO sharing the same server. Running both meant
  // two things racing to close one listener: the plugin waited forever on
  // connections engine.io held open, and `server.stop()` never resolved, so every
  // drain sat until its deadline.
  //
  // If you remove the shutdown handler below, put this plugin back.
  plugins: [],
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

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Registered BEFORE the database connect below, deliberately. Connecting to
// Atlas can take several seconds on a cold start, and a SIGTERM arriving in that
// window would otherwise hit Node's default handler and kill the process outright
// — no drain, no cleanup. Deploys and autoscaling both produce exactly that race.
// Nothing listened for SIGTERM, so every deploy killed in-flight GraphQL requests
// and dropped every WebSocket without a close frame — clients saw it as a network
// error rather than a reconnect.
//
// Order matters: stop accepting new work, let running work finish, then close the
// resources that work depends on.
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return; // a second signal shouldn't restart the sequence
  shuttingDown = true;
  console.log(`⏹️  [SERVER] ${signal} received — draining`);

  // Fail health checks immediately so the load balancer stops routing here
  // while the drain runs.
  const forceExit = setTimeout(() => {
    console.error("⚠️  [SERVER] Drain timed out — forcing exit");
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  /**
   * Run one shutdown step with its own deadline.
   *
   * Every step here closes a connection to something that may itself be sick —
   * that is often *why* the process is being restarted. Closing a BullMQ worker
   * whose Redis is unreachable, for example, blocks indefinitely. Bounding each
   * step means one unreachable dependency degrades that step alone instead of
   * stalling the whole drain until the force-exit timer fires.
   */
  async function step(name: string, fn: () => Promise<unknown>, ms = 4000) {
    const started = Date.now();
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref()),
      ]);
      console.log(`   ✓ ${name} (${Date.now() - started}ms)`);
    } catch (err: any) {
      // Deliberately not fatal: a step that won't close cleanly should not stop
      // the remaining steps from trying.
      console.warn(`   ! ${name} — ${err?.message ?? err} (${Date.now() - started}ms)`);
    }
  }

  // 1. Stop accepting NEW connections. Existing in-flight requests keep running.
  await step("listener", async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }, 6000);

  // 2. Hang up WebSocket clients so they reconnect, then detach engine.io.
  await step("sockets", async () => {
    io.disconnectSockets(true);
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }, 3000);

  // 3. Let in-flight GraphQL operations finish, then stop Apollo.
  await step("apollo", () => server.stop(), 6000);

  // 4. Close the BullMQ workers. Each holds a blocking Redis read that keeps the
  //    event loop alive, so without this the process never exits on its own.
  await step("queues", () => Promise.all([closeScheduledJobs(), closeChatQueue()]));

  // 5. Now that nothing else needs them, close the data connections.
  await step("cache", () => closeCache());
  await step("mongo", () => mongoose.connection.close(false));

  console.log("✅ [SERVER] Drained");
  clearTimeout(forceExit);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Await the DB before accepting traffic. This used to be fire-and-forget, so the
// server started listening while Mongo was still connecting and the first
// requests after a deploy failed against a connection that wasn't up yet.
await connectDB();

httpServer.listen(PORT, async () => {
  console.log(`🚀 [SERVER] Running on port ${PORT} (${isProd ? "production" : "development"})`);
  await initScheduledJobs();
});
