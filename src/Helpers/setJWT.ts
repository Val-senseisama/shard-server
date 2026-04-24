import jwt from "jsonwebtoken";
import { createHash } from "crypto";
import "dotenv/config";
import { catchError, logError, ThrowError, uuid } from "./Helpers.js";
import { User } from "../models/User.js";

/** SHA-256 hash of a refresh token key — stored instead of the raw value */
export const hashRefreshToken = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

const setJWT = async (userID: string) => {
  let currentUser: any = {};
  let error: Error | null = null;

  [error, currentUser] = await catchError(
    User.findById(userID, "username email role isActive").lean()
  );

  if (error) {
    logError("setJWT", error);
    ThrowError("An error occurred while fetching user information.");
  }

  if (!currentUser || !currentUser._id) ThrowError("User token error.");
  if (!currentUser.isActive) ThrowError("Your account has been deactivated. Please contact support.");

  // Access token — short-lived, contains non-sensitive claims
  const accessToken = jwt.sign(
    {
      id: currentUser._id.toString(),
      email: currentUser.email,
      username: currentUser.username,
      role: currentUser.role,
    },
    process.env.JWT_ACCESS_TOKEN_SECRET!,
    { expiresIn: +process.env.JWT_ACCESS_TOKEN_EXPIRES_IN! * 60 * 1000 }
  );

  // Refresh token — opaque key, stored as SHA-256 hash in DB
  const rawKey = uuid();
  const hashedKey = hashRefreshToken(rawKey);

  [error] = await catchError(
    User.findByIdAndUpdate(userID, {
      $push: { refreshTokens: hashedKey },
    })
  );

  if (error) {
    logError("setJWT", error);
    ThrowError("An error occurred while updating user information.");
  }

  // JWT carries the raw key — the DB stores only the hash
  const refreshToken = jwt.sign(
    { id: currentUser._id.toString(), token: rawKey },
    process.env.JWT_REFRESH_TOKEN_SECRET!,
    { expiresIn: +process.env.JWT_REFRESH_TOKEN_EXPIRES_IN! * 24 * 60 * 60 * 1000 }
  );

  return { accessToken, refreshToken };
};

export default setJWT;
