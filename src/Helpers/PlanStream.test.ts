import { describe, it, expect, vi } from "vitest";

vi.mock("./Helpers.js", () => ({ logError: vi.fn() }));

import { PhaseExtractor } from "./PlanStream.js";

const PLAN = {
  mainQuest: { title: "Run a half marathon", xpReward: 200 },
  miniQuests: [
    { title: "Base building", estimatedDuration: "3 weeks", steps: [{ text: "Easy 5k" }, { text: "Rest" }] },
    { title: "Build volume", estimatedDuration: "4 weeks", steps: [{ text: "Long run" }] },
    { title: "Taper", estimatedDuration: "1 week", steps: [] },
  ],
  warning: null,
};

/** Feed a string in fixed-size slices, collecting everything emitted. */
const feed = (json: string, size: number) => {
  const ex = new PhaseExtractor();
  const out: any[] = [];
  for (let i = 0; i < json.length; i += size) out.push(...ex.push(json.slice(i, i + size)));
  return { out, ex };
};

describe("PhaseExtractor", () => {
  it("emits each phase as its closing brace arrives", () => {
    const { out } = feed(JSON.stringify(PLAN), 4096);

    expect(out.map((p) => p.title)).toEqual(["Base building", "Build volume", "Taper"]);
    expect(out[0].stepCount).toBe(2);
    expect(out[2].stepCount).toBe(0);
    expect(out[0].estimatedDuration).toBe("3 weeks");
  });

  it("gives the same result whatever the chunk boundaries are", () => {
    // The real hazard: a network chunk can split anywhere, including mid-brace
    // and mid-string. Every slicing must produce the identical sequence.
    const json = JSON.stringify(PLAN);
    for (const size of [1, 2, 3, 7, 13, 64, 500]) {
      const { out } = feed(json, size);
      expect(out.map((p) => p.title), `chunk size ${size}`).toEqual([
        "Base building",
        "Build volume",
        "Taper",
      ]);
    }
  });

  it("never emits the same phase twice", () => {
    const ex = new PhaseExtractor();
    const json = JSON.stringify(PLAN);
    const first = ex.push(json);
    const second = ex.push(""); // a chunk that adds nothing

    expect(first).toHaveLength(3);
    expect(second).toHaveLength(0);
  });

  it("is not fooled by braces inside strings", () => {
    const tricky = JSON.stringify({
      miniQuests: [
        { title: "Handle {braces} and \\\" quotes", steps: [{ text: "a } here" }] },
        { title: "Second", steps: [] },
      ],
    });

    const { out } = feed(tricky, 3);

    expect(out.map((p) => p.title)).toEqual(['Handle {braces} and \\" quotes', "Second"]);
  });

  it("emits nothing until the miniQuests array actually starts", () => {
    const ex = new PhaseExtractor();

    // The main quest is an object too — it must not be mistaken for a phase.
    expect(ex.push('{"mainQuest":{"title":"Something","xpReward":200},')).toHaveLength(0);
    // Genuinely unterminated: the steps array is still open.
    expect(ex.push('"miniQuests":[{"title":"First","steps":[{"text":"a"}')).toHaveLength(0);
    expect(ex.push("]}]").map((p) => p.title)).toEqual(["First"]);
  });

  it("ignores an entry with no title rather than emitting a blank card", () => {
    const { out } = feed(
      JSON.stringify({ miniQuests: [{ steps: [] }, { title: "Real", steps: [] }] }),
      5
    );

    expect(out.map((p) => p.title)).toEqual(["Real"]);
  });

  it("keeps the full text for the caller's own final parse", () => {
    const json = JSON.stringify(PLAN);
    const { ex } = feed(json, 17);

    // Streaming is a side channel — what gets saved is parsed from this.
    expect(JSON.parse(ex.text()).miniQuests).toHaveLength(3);
  });

  it("survives a response that is cut off mid-phase", () => {
    const json = JSON.stringify(PLAN);
    const { out } = feed(json.slice(0, json.length - 40), 9);

    // Whatever completed still arrived; the truncated tail simply never emits.
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].title).toBe("Base building");
  });
});
