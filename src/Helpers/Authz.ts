import { User } from "../models/User.js";
import { ThrowError } from "./Helpers.js";

/**
 * Admin authorisation, verified against the database.
 *
 * `context.role` comes from the access-token claims, which are minted at login
 * and never revisited for the life of the token. Trusting it meant a demoted
 * admin — or a deactivated one — kept full admin powers until their token
 * expired. Admin traffic is a rounding error in request volume, so the correct
 * trade here is to pay one indexed read and be right.
 *
 * Normal user requests deliberately do NOT pay this cost: they keep the
 * token-only fast path in middleware/CreateContext.ts, which means a
 * deactivation takes effect for them within the access-token TTL
 * (JWT_ACCESS_TOKEN_EXPIRES_IN, 15 minutes) rather than instantly. That is a
 * bounded, documented lag — it was 10.4 days before the expiry unit fix in
 * Helpers/setJWT.ts.
 */
export async function assertAdmin(context: any): Promise<void> {
  if (!context?.id) ThrowError("Please login to continue.");

  const user = await User.findById(context.id, "role isActive").lean();

  if (!user) ThrowError("Please login to continue.");
  if (!(user as any).isActive) ThrowError("Your account has been deactivated. Please contact support.");
  if ((user as any).role !== "admin") ThrowError("Admin access required.");
}

/**
 * Non-throwing variant, for the places that *branch* on admin-ness rather than
 * require it (e.g. "admins see every support flag, everyone else sees only
 * their own"). Same DB-backed check as `assertAdmin`.
 */
export async function isAdmin(context: any): Promise<boolean> {
  if (!context?.id) return false;
  const user = await User.findById(context.id, "role isActive").lean();
  return !!user && (user as any).isActive === true && (user as any).role === "admin";
}
