import { describe, it, expect } from "vitest";
import {
  applyEnrichmentDiff,
  detectProvider,
  extractPlaylistId,
  extractVideoId,
  type Curriculum,
} from "./Curriculum.js";

describe("Curriculum helper & Enrichment Diff", () => {
  const baseCurriculum: Curriculum = {
    provider: "youtube",
    fidelity: "exact",
    title: "Web Dev 101",
    sections: [
      {
        title: "All Videos",
        items: [
          { kind: "lecture", title: "HTML Basics", durationSeconds: 600 },
          { kind: "lecture", title: "CSS Basics", durationSeconds: 800 },
          { kind: "lecture", title: "JS Basics", durationSeconds: 1200 },
          { kind: "lecture", title: "Advanced Topics", durationSeconds: 1500 },
        ],
      },
    ],
    fetchedAt: new Date("2026-08-17T00:00:00Z"),
  };

  it("detects providers correctly from URLs", () => {
    expect(detectProvider("https://www.youtube.com/playlist?list=PL123")).toBe("youtube");
    expect(detectProvider("https://youtu.be/watch?v=abc")).toBe("youtube");
    expect(detectProvider("https://www.udemy.com/course/react")).toBe("udemy");
    expect(detectProvider("https://www.coursera.org/learn/algorithms")).toBe("coursera");
    expect(detectProvider("https://www.edx.org/course/cs50")).toBe("edx");
    expect(detectProvider("https://example.com/syllabus")).toBe("web");
    expect(detectProvider("invalid url")).toBeNull();
  });

  it("extracts YouTube playlist and video IDs", () => {
    expect(extractPlaylistId("https://www.youtube.com/playlist?list=PLxyz123")).toBe("PLxyz123");
    expect(extractPlaylistId("https://www.youtube.com/watch?v=abc&list=PLxyz123")).toBe("PLxyz123");
    expect(extractPlaylistId("https://www.youtube.com/watch?v=abc")).toBeNull();

    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("applies a valid enrichment diff with regrouping, optional items, and practice", () => {
    const diff = {
      sections: [
        { title: "Frontend Foundations", itemRange: [0, 1] },
        { title: "JavaScript & Beyond", itemRange: [2, 3] },
      ],
      optional: [3],
      practice: [
        { afterIndex: 1, title: "Build a static card", estimatedMinutes: 20 },
      ],
    };

    const enriched = applyEnrichmentDiff(baseCurriculum, diff);

    expect(enriched.sections).toHaveLength(2);
    expect(enriched.sections[0].title).toBe("Frontend Foundations");
    // Items: HTML Basics, CSS Basics + synthesized Practice
    expect(enriched.sections[0].items).toHaveLength(3);
    expect(enriched.sections[0].items[2].kind).toBe("practice");
    expect(enriched.sections[0].items[2].synthesized).toBe(true);

    expect(enriched.sections[1].title).toBe("JavaScript & Beyond");
    expect(enriched.sections[1].items).toHaveLength(2);
    expect(enriched.sections[1].items[1].optional).toBe(true);
  });

  it("safely ignores an invalid / out-of-bounds diff and returns raw curriculum", () => {
    const invalidDiff = {
      sections: [
        { title: "Invalid Range", itemRange: [0, 10] }, // index 10 > 3
      ],
    };

    const result = applyEnrichmentDiff(baseCurriculum, invalidDiff);
    expect(result).toEqual(baseCurriculum);
  });

  it("rejects overlapping ranges and returns raw curriculum", () => {
    const overlappingDiff = {
      sections: [
        { title: "Part 1", itemRange: [0, 2] },
        { title: "Part 2", itemRange: [2, 3] }, // index 2 overlaps!
      ],
    };

    const result = applyEnrichmentDiff(baseCurriculum, overlappingDiff);
    expect(result).toEqual(baseCurriculum);
  });
});
