import crypto from "crypto";

/**
 * Generate Cloudinary signed upload parameters for frontend uploads
 * @param folder - Cloudinary folder path (e.g., "shard-server/profile-pics")
 * @returns Signed upload parameters
 */
export function getCloudinarySignedUpload(folder: string = "shard-server/users") {
  if (!process.env.CLOUDINARY_API_SECRET) {
    throw new Error("CLOUDINARY_API_SECRET is not configured");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `${folder}/${crypto.randomUUID()}`;

  // Create signature for upload - must match the parameters sent to Cloudinary
  // Parameters must be in alphabetical order
  const paramsToSign = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}`;
  const signature = crypto
    .createHash("sha1")
    .update(`${paramsToSign}${process.env.CLOUDINARY_API_SECRET}`)
    .digest("hex");

  return {
    publicId,
    signature,
    timestamp,
    folder,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || "unsigned", // Optional unsigned preset
  };
}

/**
 * Delete image from Cloudinary
 * @param publicId - Cloudinary public ID
 * @returns Deletion result
 */
export async function deleteCloudinaryImage(publicId: string) {
  if (!process.env.CLOUDINARY_API_SECRET) {
    throw new Error("CLOUDINARY_API_SECRET is not configured");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHash("sha1")
    .update(`public_id=${publicId}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`)
    .digest("hex");

  // Note: This is just the signature generation
  // Actual deletion should be done via Cloudinary SDK on backend
  return { signature, timestamp };
}

