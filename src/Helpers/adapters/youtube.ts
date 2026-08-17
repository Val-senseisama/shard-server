/**
 * YouTube Data API v3 adapter.
 *
 * The only fully-automatic import path, and the cheapest:
 *   - `playlistItems.list` (paginated, 50/page) = 1 unit/page
 *   - `videos.list?part=contentDetails` (50 ids/call)  = 1 unit/call
 * A 40-lecture course import costs 2 units against a 10,000-unit daily budget.
 *
 * §5.3 of PLAN-intake.md governs this module.
 *
 * Gating:
 *   - Requires `YOUTUBE_API_KEY` in the environment. When absent the function
 *     throws `YoutubeAdapterDisabledError` so callers can show "paste instead".
 *   - Daily quota counter in Redis (`yt:quota:YYYY-MM-DD`). Exhaustion degrades
 *     to paste, never to a failed creation.
 */

import redis from "../Cache.js";
import { logError } from "../Helpers.js";
import type { Curriculum, CurriculumItem, CurriculumSection } from "../Curriculum.js";

export class YoutubeAdapterDisabledError extends Error {
  constructor() {
    super("YouTube adapter disabled — YOUTUBE_API_KEY not set");
    this.name = "YoutubeAdapterDisabledError";
  }
}

export class YoutubeQuotaExhaustedError extends Error {
  constructor() {
    super("YouTube daily quota exhausted");
    this.name = "YoutubeQuotaExhaustedError";
  }
}

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
const MAX_ITEMS = 200;
const PAGE_SIZE = 50;
// Budget is 10,000 units/day. Reserve 80% for imports (8,000); leave the rest
// for the refresh sweep and other callers.
const DAILY_QUOTA_LIMIT = 8000;

function getApiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new YoutubeAdapterDisabledError();
  return key;
}

function quotaKey(): string {
  return `yt:quota:${new Date().toISOString().slice(0, 10)}`;
}

async function spendQuota(units: number): Promise<void> {
  const key = quotaKey();
  const current = await redis.incrby(key, units).catch(() => 0);
  if (current === units) {
    // First spend today — set expiry to midnight + buffer.
    await redis.expireat(key, tomorrowMidnightEpoch()).catch(() => {});
  }
  if (current > DAILY_QUOTA_LIMIT) {
    // Rolled past the limit — decrement so later calls see accurate counts.
    await redis.decrby(key, units).catch(() => {});
    throw new YoutubeQuotaExhaustedError();
  }
}

async function checkQuota(units: number): Promise<void> {
  const key = quotaKey();
  const current = parseInt((await redis.get(key).catch(() => "0")) ?? "0", 10);
  if (current + units > DAILY_QUOTA_LIMIT) throw new YoutubeQuotaExhaustedError();
}

function tomorrowMidnightEpoch(): number {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

async function ytFetch<T>(
  path: string,
  params: Record<string, string>
): Promise<T> {
  const apiKey = getApiKey();
  const url = new URL(`${YT_API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`YouTube API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

interface YtPlaylistItem {
  snippet: {
    title: string;
    position: number;
    resourceId: { videoId: string };
    thumbnails?: { medium?: { url: string } };
    channelTitle?: string;
    description?: string;
  };
  status?: { privacyStatus: string };
}

interface YtVideo {
  id: string;
  contentDetails: { duration: string };
  snippet: { title: string; channelTitle?: string };
}

/** Parse ISO-8601 duration (PT1H2M10S) to seconds. */
function parseDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] ?? "0") * 3600) +
    (parseInt(m[2] ?? "0") * 60) +
    parseInt(m[3] ?? "0");
}

/** Titles YouTube uses for unavailable videos. */
const UNAVAILABLE_TITLES = new Set([
  "Deleted video",
  "Private video",
  "[Deleted]",
  "[Private]",
]);

function isUnavailable(item: YtPlaylistItem): boolean {
  return (
    UNAVAILABLE_TITLES.has(item.snippet.title) ||
    item.status?.privacyStatus === "private" ||
    !item.snippet.resourceId?.videoId
  );
}

function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Fallback importer using YouTube's public playlist RSS Atom feed.
 * Requires no API key or quota and works for all public YouTube playlists.
 */
export async function importYouTubePlaylistViaFeed(
  playlistId: string,
  channelName?: string,
  _goal?: string
): Promise<{ curriculum: Curriculum; notice?: string }> {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(playlistId)}`;
  const res = await fetch(feedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/xml, text/xml, */*",
    },
  });

  if (!res.ok) {
    throw new Error(`YouTube RSS feed returned status ${res.status}`);
  }

  const xml = await res.text();
  const titleMatch = xml.match(/<title>([^<]+)<\/title>/);
  const authorMatch = xml.match(/<author>[\s\S]*?<name>([^<]+)<\/name>/);

  const playlistTitle = titleMatch ? unescapeXml(titleMatch[1].trim()) : "YouTube Playlist";
  const playlistAuthor =
    channelName || (authorMatch ? unescapeXml(authorMatch[1].trim()) : undefined);

  const entries: Array<{ videoId: string; title: string }> = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;

  while ((m = entryRegex.exec(xml)) !== null) {
    const entryXml = m[1];
    const vidMatch = entryXml.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const itemTitleMatch = entryXml.match(/<title>([^<]+)<\/title>/);
    if (vidMatch && vidMatch[1]) {
      const videoId = vidMatch[1].trim();
      const rawTitle = itemTitleMatch ? itemTitleMatch[1].trim() : "Untitled Video";
      if (!UNAVAILABLE_TITLES.has(rawTitle)) {
        entries.push({
          videoId,
          title: unescapeXml(rawTitle),
        });
      }
    }
  }

  if (entries.length === 0) {
    const curriculum: Curriculum = {
      provider: "youtube",
      fidelity: "exact",
      title: playlistTitle,
      author: playlistAuthor,
      sections: [],
      fetchedAt: new Date(),
    };
    return {
      curriculum,
      notice: "This playlist appears to be empty or private.",
    };
  }

  const items: CurriculumItem[] = entries.map((e) => ({
    kind: "lecture" as const,
    title: e.title,
    url: `https://www.youtube.com/watch?v=${e.videoId}&list=${playlistId}`,
    externalId: e.videoId,
  }));

  const section: CurriculumSection = {
    title: playlistTitle || "Playlist",
    items,
  };

  const curriculum: Curriculum = {
    provider: "youtube",
    fidelity: "exact",
    title: playlistTitle,
    author: playlistAuthor,
    url: `https://www.youtube.com/playlist?list=${playlistId}`,
    sections: [section],
    fetchedAt: new Date(),
  };

  return {
    curriculum,
  };
}

/**
 * Import a YouTube playlist via YouTube Data API v3.
 */
async function importYouTubePlaylistViaApi(
  playlistId: string,
  channelName?: string,
  _goal?: string
): Promise<{ curriculum: Curriculum; notice?: string }> {
  // Pre-flight quota check (conservative: assume 4 units for a 200-item list).
  await checkQuota(4);

  let pageToken: string | undefined;
  let allItems: YtPlaylistItem[] = [];
  let playlistTitle = "";
  let playlistAuthor = channelName ?? "";
  let skippedCount = 0;
  let truncated = false;

  // Paginate through the playlist.
  do {
    const params: Record<string, string> = {
      part: "snippet,status",
      playlistId,
      maxResults: String(PAGE_SIZE),
    };
    if (pageToken) params.pageToken = pageToken;

    // Spend 1 unit per page.
    await spendQuota(1);

    const data = await ytFetch<{
      items: YtPlaylistItem[];
      nextPageToken?: string;
      snippet?: { title: string; channelTitle?: string };
    }>("playlistItems", params);

    // Capture playlist metadata from the first page.
    if (!playlistTitle && data.snippet?.title) {
      playlistTitle = data.snippet.title;
      playlistAuthor = playlistAuthor || data.snippet.channelTitle || "";
    }

    const available: YtPlaylistItem[] = [];
    for (const item of data.items ?? []) {
      if (isUnavailable(item)) {
        skippedCount++;
      } else {
        available.push(item);
      }
    }

    allItems.push(...available);
    pageToken = data.nextPageToken;

    if (allItems.length >= MAX_ITEMS) {
      truncated = true;
      allItems = allItems.slice(0, MAX_ITEMS);
      break;
    }
  } while (pageToken);

  if (allItems.length === 0) {
    // Playlist exists but has no accessible videos.
    const curriculum: Curriculum = {
      provider: "youtube",
      fidelity: "exact",
      title: playlistTitle || "YouTube Playlist",
      author: playlistAuthor,
      sections: [],
      fetchedAt: new Date(),
    };
    return {
      curriculum,
      notice: skippedCount
        ? `All ${skippedCount} videos in this playlist are unavailable.`
        : "This playlist appears to be empty.",
    };
  }

  // ── Fetch durations ────────────────────────────────────────────────────────
  const videoIds = allItems.map((i) => i.snippet.resourceId.videoId);
  const durationMap = new Map<string, number>();

  // Batch 50 at a time.
  for (let i = 0; i < videoIds.length; i += PAGE_SIZE) {
    const batch = videoIds.slice(i, i + PAGE_SIZE);
    await spendQuota(1);
    const data = await ytFetch<{ items: YtVideo[] }>("videos", {
      part: "contentDetails,snippet",
      id: batch.join(","),
    });
    for (const v of data.items ?? []) {
      durationMap.set(v.id, parseDuration(v.contentDetails.duration));
      // Update author from first video if not set.
      if (!playlistAuthor && v.snippet.channelTitle) {
        playlistAuthor = v.snippet.channelTitle;
      }
    }
  }

  // ── Build CurriculumItems ─────────────────────────────────────────────────
  const items: CurriculumItem[] = allItems.map((item) => {
    const videoId = item.snippet.resourceId.videoId;
    return {
      kind: "lecture" as const,
      title: item.snippet.title,
      durationSeconds: durationMap.get(videoId),
      url: `https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`,
      externalId: videoId,
    };
  });

  // A flat playlist becomes a single section. Enrichment will group it
  // if the course has coherent topics.
  const section: CurriculumSection = {
    title: playlistTitle || "Playlist",
    items,
  };

  const totalSeconds = items.reduce(
    (sum, i) => sum + (i.durationSeconds ?? 0),
    0
  );

  const curriculum: Curriculum = {
    provider: "youtube",
    fidelity: "exact",
    title: playlistTitle || "YouTube Playlist",
    author: playlistAuthor || undefined,
    url: `https://www.youtube.com/playlist?list=${playlistId}`,
    sections: [section],
    totalSeconds,
    fetchedAt: new Date(),
  };

  const noticeParts: string[] = [];
  if (skippedCount > 0) {
    noticeParts.push(
      `${skippedCount} unavailable video${skippedCount > 1 ? "s" : ""} skipped`
    );
  }
  if (truncated) {
    noticeParts.push(
      `capped at ${MAX_ITEMS} videos (playlist has more)`
    );
  }

  return {
    curriculum,
    notice: noticeParts.length > 0 ? noticeParts.join("; ") : undefined,
  };
}

/**
 * Import a YouTube playlist as a Curriculum.
 *
 * @param playlistId - The YouTube playlist ID (from `list=` query parameter).
 * @param channelName - Optional: pre-fetched channel name for attribution.
 * @param goal - What the user wants out of the course (drives optional marking).
 * @returns { curriculum, notice } — notice is set when videos were skipped.
 */
export async function importYouTubePlaylist(
  playlistId: string,
  channelName?: string,
  goal?: string
): Promise<{ curriculum: Curriculum; notice?: string }> {
  if (process.env.YOUTUBE_API_KEY) {
    try {
      return await importYouTubePlaylistViaApi(playlistId, channelName, goal);
    } catch (err) {
      if (err instanceof YoutubeQuotaExhaustedError) {
        throw err;
      }
      logError("importYouTubePlaylist:api_fallback_to_feed", err);
      return await importYouTubePlaylistViaFeed(playlistId, channelName, goal);
    }
  }

  return await importYouTubePlaylistViaFeed(playlistId, channelName, goal);
}

/**
 * Get quota used today. Used by the dashboard and monitoring.
 */
export async function getYoutubeQuotaUsed(): Promise<number> {
  const val = await redis.get(quotaKey()).catch(() => null);
  return val ? parseInt(val, 10) : 0;
}
