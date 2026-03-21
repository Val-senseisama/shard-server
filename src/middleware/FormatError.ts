/**
 * Formats and logs GraphQL errors to a user-friendly, non-technical format.
 * In development, logs and returns the full error message.
 * In production, logs the error but returns a generic, non-technical message.
 * @param error The original GraphQL error object
 * @returns An object with a user-friendly message and optional code
 */
export function formatError(error: any) {
  const env = process.env.NODE_ENV || "development";

  // Always log the full error for server-side debugging
  console.error("GraphQL Error:", error);

  if (env === "development") {
    // In development, return the full error message and stack if available
    return {
      message: error?.message || "An error occurred.",
      code: error?.extensions?.code,
      stack: error?.stack,
      path: error?.path,
    };
  }

  // In production, return a user-friendly message
  let message = "An unexpected error occurred. Please try again later.";
  let code: string | undefined = undefined;

  if (error?.message) {
    if (
      error.message.includes("duplicate key error") ||
      error.message.includes("E11000")
    ) {
      message = "A record with this information already exists.";
      code = "DUPLICATE_RECORD";
    } else if (
      error.message.toLowerCase().includes("validation") ||
      error.message.toLowerCase().includes("cast to objectid failed")
    ) {
      message = "Invalid input. Please check your data and try again.";
      code = "INVALID_INPUT";
    } else if (
      error.message.toLowerCase().includes("not found")
    ) {
      message = "The requested resource was not found.";
      code = "NOT_FOUND";
    } else if (
      error.message.toLowerCase().includes("unauthorized") ||
      error.message.toLowerCase().includes("authentication")
    ) {
      message = "You are not authorized to perform this action.";
      code = "UNAUTHORIZED";
    } else {
      message = "Something went wrong. Please try again.";
    }
  }

  return {
    message,
    code,
  };
}

