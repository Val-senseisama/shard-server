// Import the necessary modules and types.
import { GraphQLError } from "graphql"; // Module for creating GraphQL errors.
import { DateTime } from "luxon"; // Module for date and time manipulation.
import { AuditTrailType, LogType } from "./types.js"; 
import AuditTrail from "../models/AuditTrail.js";
import ErrorLog from "../models/ErrorLog.js";

let logCache: LogType[] = [];

// Array to store pending audit trails.
let pendingAuditTrails: AuditTrailType[] = [];

// Set an interval to commit memory (save logs and audit trails) at regular intervals.
setInterval(() => {
  commitMemory();
}, 1 * 60 * 1000);

// Function to log messages.
export const logError = async (task: string, msg: any): Promise<void> => {
  // If the message is not a string, convert it to a string.
  if (typeof msg != "string") msg = JSON.stringify(msg, null, 2);

  const now = DateTime.now().toSQL();
  // Add the log to the log cache.
  logCache.push({
    task: task,
    errorMessage: msg,
    timestamp: now,
  });

  // If the log cache exceeds the maximum stack size, commit memory.
  if (logCache.length > 3) {
    commitMemory();
  }
};

// Function to commit memory (save logs and audit trails) to the database.
async function commitMemory(): Promise<void> {
  // If there are pending audit trails, insert them into the database.
  if (pendingAuditTrails.length > 0) {
    const auditTrails = pendingAuditTrails;
    pendingAuditTrails = [];

    const [insertError, insertResult] = await catchError(
      AuditTrail.insertMany(auditTrails)
    );
    if (insertError) {
      logError("commitMemory", insertError);
    }
  }

  // If there are logs in the log cache, insert them into the database.
  if (logCache.length > 0) {
    const data = logCache;
    logCache = [];
    const [insertError, insertResult] = await catchError(
      ErrorLog.insertMany(data)
    );
    if (insertError) {
      logError("commitMemory", insertError);
    }
  }
}

// Function to throw a GraphQL error.
export const ThrowError = (message: string): never => {
  // Throw a GraphQL error with the given message and extensions.
  throw new GraphQLError(message, {
    extensions: { code: "USER" },
  });
};



// Function to generate a unique ID.
export const MakeID = (length: number): string => {
  var result = "";
  var characters = "ABCDEFGHJKLMNPQRTUVWXY346789";
  var charactersLength = characters.length;
  for (var i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
};

// Function to generate a UUID v7.
export const uuid = (): string => {
  const timestamp = BigInt(Date.now());
  const random = BigInt(Math.floor(Math.random() * 0x1000000000000));

  // Format as UUIDv7: timestamp (48 bits) + random (12 bits) + version (4 bits) + random (12 bits) + variant (2 bits) + random (62 bits)
  const uuid = [
    timestamp.toString(16).padStart(12, "0"),
    (random & 0xfffn).toString(16).padStart(3, "0"),
    "7", // version 7
    ((random >> 12n) & 0xfffn).toString(16).padStart(3, "0"),
    "8", // variant
    (random >> 24n).toString(16).padStart(15, "0"),
  ].join("");

  return [
    uuid.slice(0, 8),
    uuid.slice(8, 12),
    uuid.slice(12, 16),
    uuid.slice(16, 20),
    uuid.slice(20, 32),
  ].join("-");
};

export async function catchError<T>(
  promise: Promise<T>
): Promise<[undefined, T] | [Error]> {
  try {
    const data = await promise;
    return [undefined, data] as [undefined, T];
  } catch (error) {
    return [error];
  }
}

const URL_REGEX = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

// Basic blocklist of known malicious/phishing domain patterns
const BLOCKED_DOMAINS = [
  'bit.ly/malware', 'phishing-site.com', 'malware-download.net',
  'free-virus.com', 'click-here-now.ru', 'urgent-account-verify.com',
];

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX);
  return matches ? [...new Set(matches)] : [];
}

export async function scanLink(url: string): Promise<{ safe: boolean; threat?: string }> {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    // Check against blocklist
    const blocked = BLOCKED_DOMAINS.some(d => hostname.includes(d));
    if (blocked) {
      return { safe: false, threat: 'blocked_domain' };
    }

    // Optional: Google Safe Browsing API (used only if key is configured)
    const apiKey = process.env.GOOGLE_SAFE_BROWSING_KEY;
    if (apiKey) {
      try {
        const res = await fetch(
          `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client: { clientId: 'shard-app', clientVersion: '1.0' },
              threatInfo: {
                threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'],
                platformTypes: ['ANY_PLATFORM'],
                threatEntryTypes: ['URL'],
                threatEntries: [{ url }],
              },
            }),
          }
        );
        const data: any = await res.json();
        if (data.matches && data.matches.length > 0) {
          return { safe: false, threat: data.matches[0].threatType };
        }
      } catch {
        // Safe Browsing API failure — don't block the message
      }
    }

    return { safe: true };
  } catch {
    // URL parse failed or network error — allow through
    return { safe: true };
  }
}

export const SaveAuditTrail = async (data: AuditTrailType): Promise<void> => {
  pendingAuditTrails.push(data);
  if (pendingAuditTrails.length > 30) {
    await commitMemory();
  }
};
