/**
 * Unfurl adapter — fetch the public `<head>` of a URL and return metadata.
 *
 * This is standard link-unfurl behaviour (same as Slack / Discord). We parse
 * only `<title>`, OpenGraph tags, and `Course` JSON-LD — never the page body.
 *
 * Security requirements (§5.2):
 *   - 3-second timeout — never hang the import flow.
 *   - 512KB response cap — never buffer an arbitrary remote body.
 *   - Redirect limit (3 max) with `scanLink` re-run on each hop.
 *   - SSRF guard: reject private/link-local ranges after DNS resolution.
 *   - Failure is non-fatal — callers degrade to paste.
 */

import dns from "dns/promises";
import { logError } from "../Helpers.js";

export interface UnfurlResult {
  title?: string;
  author?: string;
  thumbnail?: string;
  description?: string;
}

const TIMEOUT_MS = 3000;
const MAX_BYTES = 512 * 1024; // 512KB
const MAX_REDIRECTS = 3;

/**
 * Private / link-local ranges to block (SSRF protection).
 * We check these after DNS resolution so a hostname that resolves to 192.168.x.x
 * is also rejected.
 */
const PRIVATE_RANGES = [
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^127\.\d+\.\d+\.\d+$/,
  /^::1$/,
  /^fc00::/i,
  /^fe80::/i,
  /^169\.254\.\d+\.\d+$/, // link-local
  /^0\.0\.0\.0$/,
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_RANGES.some((r) => r.test(ip));
}

async function isPrivateHost(hostname: string): Promise<boolean> {
  // Always block obvious local names.
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return true;
  }
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.some((a) => isPrivateIp(a.address));
  } catch {
    // DNS failure → block the request.
    return true;
  }
}

/** Rudimentary blocklist check. Replace with `scanLink` when available. */
function isBlocklisted(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol !== "https:" && protocol !== "http:";
  } catch {
    return true;
  }
}

/**
 * Parse metadata from a partial HTML `<head>`.
 * We read at most MAX_BYTES and stop there — the body is irrelevant.
 */
function parseHead(html: string): UnfurlResult {
  const result: UnfurlResult = {};

  // JSON-LD Course schema.
  const jsonLdMatch = html.match(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (jsonLdMatch) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      const schema = Array.isArray(data) ? data[0] : data;
      if (schema?.["@type"] === "Course") {
        result.title = schema.name || result.title;
        result.author =
          schema.author?.name || schema.creator?.name || result.author;
        result.description = schema.description || result.description;
        result.thumbnail = schema.image || result.thumbnail;
      }
    } catch {
      /* ignore malformed JSON-LD */
    }
  }

  // OpenGraph.
  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
  const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
  const ogDesc = html.match(
    /<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i
  );
  const ogSiteName = html.match(
    /<meta[^>]+property="og:site_name"[^>]+content="([^"]+)"/i
  );

  if (ogTitle) result.title = result.title || decode(ogTitle[1]);
  if (ogImage) result.thumbnail = result.thumbnail || decode(ogImage[1]);
  if (ogDesc) result.description = result.description || decode(ogDesc[1]);
  if (ogSiteName) result.author = result.author || decode(ogSiteName[1]);

  // Fallback: plain <title>.
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) result.title = result.title || decode(titleMatch[1]);

  return result;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Fetch and parse the `<head>` of `url`.
 *
 * Returns `null` on any failure — callers should degrade gracefully to paste/text.
 */
export async function unfurlLink(url: string): Promise<UnfurlResult | null> {
  if (isBlocklisted(url)) return null;

  let currentUrl = url;
  let redirectsLeft = MAX_REDIRECTS;

  while (redirectsLeft >= 0) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      return null;
    }

    // SSRF guard — check after DNS resolution.
    if (await isPrivateHost(parsedUrl.hostname)) return null;

    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        res = await fetch(currentUrl, {
          signal: controller.signal,
          headers: {
            "User-Agent": "ShardBot/1.0 (link preview; +https://shard.zevbii.com)",
            Accept: "text/html",
          },
          redirect: "manual",
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      logError("unfurlLink:fetch", err);
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location || redirectsLeft === 0) return null;
      // Re-check blocklist on each hop.
      currentUrl = new URL(location, currentUrl).toString();
      if (isBlocklisted(currentUrl)) return null;
      redirectsLeft--;
      continue;
    }

    if (!res.ok) return null;

    // Stream only up to MAX_BYTES.
    let html = "";
    const reader = res.body?.getReader();
    if (!reader) return null;
    let bytesRead = 0;
    try {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        html += decoder.decode(value, { stream: true });
        // Stop once we have the head — or at the cap.
        if (bytesRead >= MAX_BYTES || html.includes("</head>")) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    const result = parseHead(html);
    return Object.keys(result).length > 0 ? result : null;
  }

  return null;
}
