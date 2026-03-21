import jwt from "jsonwebtoken";
import "dotenv/config";
import setJWT from "../Helpers/setJWT.js";
import { catchError, logError, ThrowError } from "../Helpers/Helpers.js";
import { User } from "../models/User.js";

function validateAccessToken(token: string): any {
  try {
    // eslint-disable-next-line no-undef
    return jwt.verify(token, process.env.JWT_ACCESS_TOKEN_SECRET);
  } catch {
    return null;
  }
}

function validateRefreshToken(token: string): any {
  try {
    // eslint-disable-next-line no-undef
    return jwt.verify(token, process.env.JWT_REFRESH_TOKEN_SECRET);
  } catch {
    return null;
  }
}

export default async (req: any, res: any) => {
  // Set CORS headers for token exposure
  res.set({
    "Access-Control-Expose-Headers": "x-access-token,x-refresh-token",
  });

  // Get all the headers from this request
  const refreshToken = req.headers["x-refresh-token"];
  const accessToken = req.headers["x-access-token"];

  // Process as standard user
  if (accessToken || refreshToken) {
    // if the access token is still valid and we are not trying to forcefully refresh
    const decodedAccessToken: any = validateAccessToken(accessToken);

    if (decodedAccessToken && decodedAccessToken.id && decodedAccessToken.role !== "staff") {
      return {
        user: decodedAccessToken,
        ...decodedAccessToken,
        req,
        res,
      };
    }

    // if we are forcing refresh of access token
    // or the access token is no longer valid
    // check if refresh token is still valid
    const decodedRefreshToken: any = validateRefreshToken(refreshToken);
    
    // Is the refresh token still valid
    if (decodedRefreshToken && decodedRefreshToken.id) {
      // The refresh token is valid. Validate the refresh token against the database
      let thisUser: any;
      let error: Error | null = null;
      
      [error, thisUser] = await catchError(
        User.findById(decodedRefreshToken.id, "username email role isActive refreshTokens").lean()
      );
      
      if (error) {
        logError("CreateContext", error);
        ThrowError("An error occurred while fetching user information.");
      }
      
      if (!thisUser) {
        ThrowError("User not found.");
      }
      
      if (!thisUser.isActive) {
        ThrowError("Your account has been deactivated. Please contact support.");
      }
      
      // Check if the refresh token exists in user's refreshTokens array
      if (!decodedRefreshToken.token || !thisUser.refreshTokens?.includes(decodedRefreshToken.token)) {
        ThrowError("Session expired. Please login again.");
      }

      let userTokens: any;
      [error, userTokens] = await catchError(setJWT(decodedRefreshToken.id));
      if (error) {
        logError("CreateContext", error);
        ThrowError("An error occurred while setting user tokens.");
      }

      res.set({
        "x-access-token": userTokens.accessToken,
        "x-refresh-token": userTokens.refreshToken,
      });

      return {
        req,
        res,
        id: thisUser._id.toString(),
        email: thisUser.email,
        username: thisUser.username,
        role: thisUser.role,
      };
    }
  }

  // If we get here, no valid tokens were found
  return { req, res };
};
