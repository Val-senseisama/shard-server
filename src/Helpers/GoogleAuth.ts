import { OAuth2Client } from 'google-auth-library';
import "dotenv/config";

/**
 * Verify Google ID token from Firebase
 * @param idToken - Google ID token from client
 * @returns Decoded token with user info
 */
export async function verifyGoogleToken(idToken: string) {
  try {
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    // Verify the token
    const ticket = await client.verifyIdToken({
      idToken,
      audience: [
        process.env.GOOGLE_CLIENT_ID!,
        process.env.GOOGLE_ANDROID_CLIENT_ID!,
      ].filter(Boolean),
    });
    const payload = ticket.getPayload();
    if (!payload) {
      console.log("verifyGoogleToken", "Invalid token payload");
      throw new Error("Invalid token payload");
    }
    // Return user information
    return {
      googleId: payload.sub,
      email: payload.email!,
      emailVerified: payload.email_verified || false,
      name: payload.name || "",
      picture: payload.picture || "",
      given_name: payload.given_name || "",
      family_name: payload.family_name || "",
    };
  } catch (error) {
    console.log("verifyGoogleToken", error);
    throw new Error("Failed to verify Google token");
  }
}

/**
 * Generate username from email or name
 * @param email - User's email
 * @param name - User's name
 * @returns Unique username
 */
export function generateUsernameFromGoogle(email: string, name?: string): string {
  // Extract first part of name or email
  let base = name 
    ? name.split(' ')[0].toLowerCase()  // Take just the first name
    : email.split('@')[0];
  
  // Remove any non-alphanumeric characters
  base = base.replace(/[^a-z0-9]/g, '');
  
  // Add shorter random suffix (2 digits instead of 4)
  const randomSuffix = Math.floor(Math.random() * 100);
  return `${base}${randomSuffix}`;  // No underscore for cleaner look
}

