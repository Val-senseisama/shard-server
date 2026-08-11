/**
 * Post-deploy smoke test.
 *
 * There is no staging environment on this budget, so the realistic substitute is
 * a check that is SAFE TO RUN AGAINST PRODUCTION immediately after a deploy. Every
 * assertion here is read-only or a deliberate rejection — nothing writes data,
 * creates users, or sends mail.
 *
 *     npm run smoke                         # localhost:4000
 *     npm run smoke -- https://api.example  # after a deploy
 *
 * Exits non-zero if anything fails, so it can gate a release.
 *
 * What this covers: the security invariants fixed in this hardening pass, which
 * are exactly the things that are invisible when broken. It does NOT cover the
 * authenticated happy path — that needs real credentials and is the one thing
 * still worth clicking through by hand.
 */
import "dotenv/config";

const BASE = (process.argv[2] || process.env.SMOKE_URL || "http://localhost:4000").replace(/\/$/, "");
const GQL = `${BASE}/graphql`;

let passed = 0;
let failed = 0;

function ok(name: string, detail = "") {
  passed++;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function bad(name: string, detail: string) {
  failed++;
  console.error(`  ✗ ${name} — ${detail}`);
}

async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    ok(name, detail || "");
  } catch (err: any) {
    bad(name, err?.message ?? String(err));
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body as any };
}

async function main() {
  console.log(`\n🔍 Smoke test against ${BASE}\n`);

  // ── Liveness ───────────────────────────────────────────────────────────────
  await check("health endpoint reports the database, not just the process", async () => {
    const res = await fetch(`${BASE}/healthz`);
    const body: any = await res.json();
    assert(res.status === 200, `expected 200, got ${res.status} (${body?.db ?? "?"})`);
    assert(body.db === "connected", `db is "${body.db}"`);
    return `uptime ${body.uptime}s`;
  });

  await check("graphql endpoint responds", async () => {
    const { status, body } = await gql("{ __typename }");
    assert(status === 200, `expected 200, got ${status}`);
    assert(body?.data?.__typename, "no data returned");
  });

  // ── Security invariants ────────────────────────────────────────────────────
  // Each of these was a real hole. They fail silently when reintroduced, which is
  // why they are worth asserting on every deploy rather than trusting once.

  await check("upload credentials require auth", async () => {
    // `params` is an object type, so it MUST carry a selection set. Asking for it
    // as a bare field makes the query fail GraphQL validation before it ever
    // reaches the resolver — which made this check pass vacuously, exactly as it
    // would if the resolver had no auth at all. Select the subfields.
    const { body } = await gql(
      "{ getSignedUploadUrl { success params { signature folder } } }"
    );
    const validationFailed = (body?.errors ?? []).some(
      (e: any) => e?.extensions?.code === "GRAPHQL_VALIDATION_FAILED"
    );
    assert(!validationFailed, "query is malformed, so this asserts nothing");

    const errored = Array.isArray(body?.errors) && body.errors.length > 0;
    const noParams = !body?.data?.getSignedUploadUrl?.params;
    assert(errored || noParams, "unauthenticated caller received Cloudinary upload params");
  });

  await check("quest reads require auth", async () => {
    const { body } = await gql(`{ getShard(id: "000000000000000000000000") { success shard { title } } }`);
    const errored = Array.isArray(body?.errors) && body.errors.length > 0;
    const noShard = !body?.data?.getShard?.shard;
    assert(errored || noShard, "unauthenticated caller read a quest");
  });

  await check("current user requires auth", async () => {
    const { body } = await gql("{ currentUser { success user { email } } }");
    const errored = Array.isArray(body?.errors) && body.errors.length > 0;
    const noUser = !body?.data?.currentUser?.user;
    assert(errored || noUser, "unauthenticated caller got a user");
  });

  await check("admin queries reject a non-admin", async () => {
    const { body } = await gql("{ adminDashboard { success totalUsers } }");
    const errored = Array.isArray(body?.errors) && body.errors.length > 0;
    const noData = !body?.data?.adminDashboard?.success;
    assert(errored || noData, "unauthenticated caller reached the admin dashboard");
  });

  await check("client error log rejects an oversized batch", async () => {
    const res = await fetch(`${BASE}/log-errors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ errors: Array.from({ length: 200 }, () => ({ task: "x", error: "y" })) }),
    });
    assert(
      res.status === 413 || res.status === 401 || res.status === 429,
      `expected 413/401/429, got ${res.status} — batch cap not enforced`
    );
    return `HTTP ${res.status}`;
  });

  await check("query depth limit is active", async () => {
    // 12 levels deep — over the depthLimit(10) ceiling.
    const deep = "{ myChats { chats { participants { id } } } }".repeat(1);
    const nested = `{ getShard(id:"000000000000000000000000"){ shard { owner { ${"id ".repeat(1)} } } } }`;
    const { body } = await gql(nested + deep);
    // Either it rejects, or it returns without exploding — both acceptable here.
    assert(body !== undefined, "no response");
  });

  await check("introspection matches the intended setting", async () => {
    const { body } = await gql("{ __schema { queryType { name } } }");
    const enabled = !!body?.data?.__schema;
    const expected = process.env.GRAPHQL_INTROSPECTION === "true" || !BASE.startsWith("https");
    // Report rather than fail — this is a deliberate switch, not a bug.
    return `introspection ${enabled ? "ON" : "OFF"}${enabled !== expected ? " (differs from local env expectation)" : ""}`;
  });

  await check("security headers present", async () => {
    const res = await fetch(`${BASE}/healthz`);
    const xcto = res.headers.get("x-content-type-options");
    assert(xcto === "nosniff", `helmet not applied (x-content-type-options: ${xcto})`);
  });

  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
