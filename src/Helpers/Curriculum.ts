/**
 * Curriculum — the normalised shape every import source produces.
 *
 * Every adapter (YouTube, text paste, vision, unfurl) converts its raw output
 * into this type. Everything downstream (enrichment, pacer, shard writer) is
 * identical regardless of source — which is what makes four adapters affordable.
 *
 * §4.1 of PLAN-intake.md governs this shape. Change it here, change it there.
 */

import type { ResourceRef } from "../models/MiniGoal.js";
export type { ResourceRef };

/**
 * Where the curriculum came from.
 *
 * NOT "manual": hand-typed plans are the existing `manual` creation mode and
 * never become a Curriculum. Items the user adds by hand in the review screen
 * belong to whatever provider the import came from.
 */
export type CourseProvider =
  | "youtube"
  | "udemy"
  | "coursera"
  | "edx"
  | "web";

/**
 * How much we actually know. Drives UI copy — never hide this from the user.
 *
 * Orthogonal to `provider`: this axis is CONFIDENCE, that one is PROVENANCE.
 * `exact` means YouTube today only because YouTube is the only open API (§3).
 * If Coursera ever opens up, it becomes `exact` with no model change.
 */
export type Fidelity =
  | "exact"      // straight from an API. Titles and durations are real.
  | "imported"   // from the user's paste/screenshot. Real, but OCR may slip.
  | "inferred";  // we had a title and nothing else — our plan, not the course's.

export interface CurriculumItem {
  kind: "lecture" | "reading" | "quiz" | "project" | "practice";
  title: string;
  durationSeconds?: number;
  url?: string;
  externalId?: string;      // YouTube videoId, etc.
  /** Enrichment may mark items skippable for this user's stated goal. */
  optional?: boolean;
  /** True when WE added it — practice checkpoints the course doesn't contain. */
  synthesized?: boolean;
}

export interface CurriculumSection {
  title: string;
  items: CurriculumItem[];
}

export interface Curriculum {
  provider: CourseProvider;
  fidelity: Fidelity;
  title: string;
  author?: string;          // channel / instructor — attribution
  url?: string;
  thumbnail?: string;
  sections: CurriculumSection[];
  totalSeconds?: number;
  fetchedAt: Date;
}

// ─── Enrichment diff ──────────────────────────────────────────────────────────

/**
 * What the enrichment LLM returns. It operates on the flat item list (all
 * sections concatenated, 0-indexed) and emits a DIFF rather than the modified
 * curriculum.
 *
 * Why a diff:
 *   1. Output size is bounded: O(sections + practice items), not O(all items).
 *      A 200-item course re-serialised blows the 2048 token ceiling.
 *   2. The diff has no field that can express reordering, deletion, or retitling
 *      of existing items — those invariants become structural rather than asserted.
 */
export interface EnrichmentSection {
  /** New section title. */
  title: string;
  /**
   * Inclusive range [start, end] into the FLAT item list (all sections
   * concatenated). Every item must fall in exactly one range.
   */
  itemRange: [number, number];
}

export interface PracticeInsertion {
  /** Insert AFTER the item at this 0-based flat index. */
  afterIndex: number;
  title: string;
  estimatedMinutes: number;
}

export interface EnrichmentDiff {
  sections: EnrichmentSection[];
  /** Flat indices of items to mark optional. */
  optional?: number[];
  renamedSections?: { index: number; title: string }[];
  practice?: PracticeInsertion[];
}

/**
 * Apply an enrichment diff to a curriculum, returning the enriched result.
 *
 * Validation rules (any violation → return the raw curriculum unchanged):
 *   - Every item must fall in exactly one section range.
 *   - Ranges must be in-bounds (0 ≤ start ≤ end < totalItems).
 *   - Ranges must be non-overlapping.
 *   - Together they must cover every item.
 *   - `afterIndex` values in practice must be in-bounds.
 *   - Practice items capped at 15% of total items (rounded up, min 1).
 *   - `optional` indices in-bounds.
 *   - A malformed / empty diff → return raw curriculum.
 *
 * The model never emits items at all, so it cannot reorder, delete, retitle or
 * re-time existing items by construction.
 */
export function applyEnrichmentDiff(
  raw: Curriculum,
  diff: unknown
): Curriculum {
  // Build the flat item list so we can work with indices.
  const flatItems: CurriculumItem[] = raw.sections.flatMap((s) => s.items);
  const totalItems = flatItems.length;

  if (totalItems === 0) return raw;

  // ── Validate diff shape ────────────────────────────────────────────────────
  if (!diff || typeof diff !== "object") return raw;
  const d = diff as Partial<EnrichmentDiff>;

  if (!Array.isArray(d.sections) || d.sections.length === 0) return raw;

  // Validate section ranges.
  const covered = new Array<boolean>(totalItems).fill(false);
  for (const sec of d.sections) {
    if (
      !Array.isArray(sec.itemRange) ||
      sec.itemRange.length !== 2 ||
      typeof sec.itemRange[0] !== "number" ||
      typeof sec.itemRange[1] !== "number"
    ) {
      return raw;
    }
    const [start, end] = sec.itemRange;
    if (start < 0 || end >= totalItems || start > end) return raw;
    for (let i = start; i <= end; i++) {
      if (covered[i]) return raw; // overlap
      covered[i] = true;
    }
    if (typeof sec.title !== "string" || !sec.title.trim()) return raw;
  }
  // All items must be covered.
  if (covered.some((v) => !v)) return raw;

  // Validate optional indices.
  const optionalSet = new Set<number>();
  if (Array.isArray(d.optional)) {
    for (const idx of d.optional) {
      if (typeof idx !== "number" || idx < 0 || idx >= totalItems) return raw;
      optionalSet.add(idx);
    }
  }

  // Validate practice insertions.
  const maxPractice = Math.max(1, Math.ceil(totalItems * 0.15));
  const practice = Array.isArray(d.practice) ? d.practice : [];
  if (practice.length > maxPractice) return raw;
  for (const p of practice) {
    if (
      typeof p.afterIndex !== "number" ||
      p.afterIndex < 0 ||
      p.afterIndex >= totalItems
    ) {
      return raw;
    }
    if (typeof p.title !== "string" || !p.title.trim()) return raw;
    if (typeof p.estimatedMinutes !== "number" || p.estimatedMinutes <= 0) return raw;
  }

  // ── Build enriched items (flat) ────────────────────────────────────────────
  // Apply optional markers.
  const enrichedFlat: CurriculumItem[] = flatItems.map((item, idx) =>
    optionalSet.has(idx) ? { ...item, optional: true } : { ...item }
  );

  // Splice practice items in reverse order to keep earlier indices valid.
  //
  // Identity, not the `synthesized` flag, marks what WE inserted: a curriculum
  // can arrive already carrying synthesized items (a second enrichment pass, or
  // an adapter that adds its own practice steps). Reading the flag would count
  // those as insertions, shifting every original index after them and silently
  // filing the tail of the course under the wrong sections.
  const insertedItems = new Set<CurriculumItem>();
  const sortedPractice = [...practice].sort((a, b) => b.afterIndex - a.afterIndex);
  for (const p of sortedPractice) {
    const inserted: CurriculumItem = {
      kind: "practice",
      title: p.title.trim(),
      durationSeconds: p.estimatedMinutes * 60,
      synthesized: true,
    };
    insertedItems.add(inserted);
    enrichedFlat.splice(p.afterIndex + 1, 0, inserted);
  }

  // ── Reconstruct sections ───────────────────────────────────────────────────
  // Ranges were validated against the PRE-practice flat list, so we need to map
  // them against the original indices (before insertion). Track which flat items
  // correspond to original indices using a parallel mapping.
  const origIndexMap: number[] = []; // origIndexMap[flatPos] = original index
  let origIdx = 0;
  for (let i = 0; i < enrichedFlat.length; i++) {
    if (insertedItems.has(enrichedFlat[i])) {
      origIndexMap.push(-1); // no original index
    } else {
      origIndexMap.push(origIdx++);
    }
  }

  const newSections: CurriculumSection[] = d.sections.map((sec) => {
    const [start, end] = sec.itemRange;
    // Collect enriched items whose original index falls in [start, end],
    // plus synthesized items inserted after an item in that range.
    const items: CurriculumItem[] = [];
    for (let i = 0; i < enrichedFlat.length; i++) {
      const oi = origIndexMap[i];
      if (oi === -1) {
        // Inserted — belongs to whichever range its predecessor belongs to.
        // Walk back past any other insertions: two practice items can share an
        // `afterIndex`, and asking the one in front (also an insertion, so -1)
        // would put this one in no section at all, dropping it.
        let prevOi = -1;
        for (let j = i - 1; j >= 0; j--) {
          if (origIndexMap[j] !== -1) {
            prevOi = origIndexMap[j];
            break;
          }
        }
        if (prevOi >= start && prevOi <= end) items.push(enrichedFlat[i]);
      } else if (oi >= start && oi <= end) {
        items.push(enrichedFlat[i]);
      }
    }
    return { title: sec.title.trim(), items };
  });

  // Apply renamed sections (index into the NEW sections array).
  if (Array.isArray(d.renamedSections)) {
    for (const r of d.renamedSections) {
      if (
        typeof r.index === "number" &&
        r.index >= 0 &&
        r.index < newSections.length &&
        typeof r.title === "string" &&
        r.title.trim()
      ) {
        newSections[r.index].title = r.title.trim();
      }
    }
  }

  const totalSeconds = newSections
    .flatMap((s) => s.items)
    .reduce((sum, item) => sum + (item.durationSeconds ?? 0), 0);

  return {
    ...raw,
    sections: newSections,
    totalSeconds: totalSeconds || raw.totalSeconds,
  };
}

// ─── Adapter registry ─────────────────────────────────────────────────────────

export type AdapterResult = {
  curriculum: Curriculum;
  notice?: string; // e.g. "3 unavailable videos skipped"
};

/**
 * Detect which provider owns a URL.
 *
 * Returns null for unrecognised hosts — callers should degrade to paste/unfurl.
 */
export function detectProvider(url: string): CourseProvider | null {
  try {
    const { hostname } = new URL(url);
    const h = hostname.replace(/^www\./, "");
    if (h === "youtube.com" || h === "youtu.be") return "youtube";
    if (h === "udemy.com") return "udemy";
    if (h === "coursera.org") return "coursera";
    if (h === "edx.org") return "edx";
    // Recognise any URL as "web" — unfurl gives us a title+image.
    return "web";
  } catch {
    return null;
  }
}

/**
 * Extract a YouTube playlist ID from the many URL forms YouTube uses.
 *
 * Forms handled:
 *   https://www.youtube.com/playlist?list=PLxxx
 *   https://www.youtube.com/watch?v=yyy&list=PLxxx
 *   https://youtu.be/yyy?list=PLxxx
 *
 * Returns null when no list parameter is present (single video without a
 * playlist context — treat as a single-item import).
 */
export function extractPlaylistId(url: string): string | null {
  try {
    const { searchParams } = new URL(url);
    return searchParams.get("list");
  } catch {
    return null;
  }
}

/** Extract a YouTube video ID from a standard watch or youtu.be URL. */
export function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}
