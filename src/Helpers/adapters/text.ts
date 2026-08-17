/**
 * Text adapter — structured curriculum from pasted text.
 *
 * When the user pastes a curriculum (copy from a course page, a book table of
 * contents, a PDF syllabus), this adapter sends it to a `LIGHT_MODEL` call and
 * asks it to identify sections and items — preserving titles verbatim, only
 * inferring boundaries.
 *
 * Produces `fidelity: "imported"` because the titles are real but OCR/paste may
 * have slips. The enrichment pass runs on top of this to add section grouping
 * and practice tasks.
 *
 * §5.4 of PLAN-intake.md governs this adapter.
 */

import { createChatCompletion } from "../LLM.js";
import { LIGHT_MODEL } from "../../config/models.js";
import { logError } from "../Helpers.js";
import type { Curriculum, CurriculumItem, CurriculumSection } from "../Curriculum.js";

/** Character budget for the pasted text before we truncate. */
const MAX_PASTE_CHARS = 12_000;

const SYSTEM_PROMPT = `You are a curriculum structuring tool. The user will paste raw text from a course page, book table of contents, or similar. Your job is to identify sections and their items, preserving every title VERBATIM. Do not invent, merge, or rephrase any title. Only infer section boundaries from visual structure (numbered headings, capitalisation, blank lines, etc.).

Return ONLY valid JSON matching this schema:
{
  "title": "Course title if identifiable, else empty string",
  "author": "Author/instructor if identifiable, else empty string",
  "sections": [
    {
      "title": "Section heading",
      "items": [
        { "title": "Item title", "kind": "lecture" | "reading" | "quiz" | "project" }
      ]
    }
  ]
}

Rules:
- If there are no clear sections, put everything under a single section with title "".
- kind defaults to "lecture" when ambiguous.
- Do not include durations (you can't know them from paste text).
- Titles are from the source, not paraphrased.`;

interface ParsedCurriculum {
  title?: string;
  author?: string;
  sections: Array<{
    title: string;
    items: Array<{ title: string; kind?: string }>;
  }>;
}

function isValidItem(x: unknown): x is { title: string; kind?: string } {
  return typeof x === "object" && x !== null && typeof (x as any).title === "string";
}

function isValidSection(
  x: unknown
): x is { title: string; items: { title: string; kind?: string }[] } {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as any).title === "string" &&
    Array.isArray((x as any).items)
  );
}

function normaliseKind(k?: string): CurriculumItem["kind"] {
  const valid = ["lecture", "reading", "quiz", "project", "practice"] as const;
  return valid.find((v) => v === k) ?? "lecture";
}

/**
 * Convert pasted curriculum text into a Curriculum.
 *
 * @param text - Raw text pasted by the user.
 * @param url - Optional source URL for attribution.
 */
export async function importPastedText(
  text: string,
  url?: string
): Promise<{ curriculum: Curriculum; notice?: string }> {
  let truncated = false;
  let input = text.trim();

  if (input.length > MAX_PASTE_CHARS) {
    input = input.slice(0, MAX_PASTE_CHARS);
    truncated = true;
  }

  let parsed: ParsedCurriculum | null = null;

  try {
    const res = await createChatCompletion({
      model: LIGHT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
      response_format: { type: "json_object" },
    });

    const content = res.choices[0]?.message?.content ?? "";
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      const raw = JSON.parse(match[0]);
      // Validate shape.
      if (Array.isArray(raw.sections)) {
        parsed = {
          title: typeof raw.title === "string" ? raw.title : "",
          author: typeof raw.author === "string" ? raw.author : "",
          sections: raw.sections.filter(isValidSection).map((s: any) => ({
            title: s.title,
            items: (s.items as unknown[]).filter(isValidItem),
          })),
        };
      }
    }
  } catch (err) {
    logError("importPastedText:llm", err);
    parsed = null;
  }

  // Fallback: one section, each non-blank line becomes an item.
  if (!parsed || parsed.sections.length === 0) {
    const lines = input
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    parsed = {
      title: "",
      author: "",
      sections: [{ title: "Course", items: lines.map((l) => ({ title: l, kind: "lecture" })) }],
    };
  }

  const sections: CurriculumSection[] = parsed.sections
    .filter((s) => s.items.length > 0)
    .map((s) => ({
      title: s.title || "Section",
      items: s.items.map((item) => ({
        kind: normaliseKind(item.kind),
        title: item.title.trim(),
      })),
    }));

  const curriculum: Curriculum = {
    provider: "web",
    fidelity: "imported",
    title: parsed.title?.trim() || "Course",
    author: parsed.author?.trim() || undefined,
    url,
    sections,
    fetchedAt: new Date(),
  };

  return {
    curriculum,
    notice: truncated
      ? "Text was truncated to fit — some items near the end may be missing."
      : undefined,
  };
}
