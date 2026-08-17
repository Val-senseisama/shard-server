import { describe, it, expect, vi } from "vitest";

vi.mock("./Helpers.js", () => ({ logError: vi.fn() }));
vi.mock("./LLM.js", () => ({
  createChatCompletion: vi.fn(),
}));

import {
  validateIntakeQuestions,
  formatBriefForPrompt,
  proposeIntakeQuestions,
  FALLBACK_QUESTIONS,
  MAX_QUESTIONS,
} from "./Intake.js";
import { createChatCompletion } from "./LLM.js";

const q = (slot: string, prompt = "A perfectly reasonable question?") => ({ slot, prompt });
const slots = (list: { slot: string }[]) => list.map((x) => x.slot);
const isFallback = (result: unknown) => expect(result).toEqual(FALLBACK_QUESTIONS);

describe("intake question validation", () => {
  it("keeps a well-formed response as-is", () => {
    const result = validateIntakeQuestions({
      questions: [
        { slot: "rhythm", prompt: "How many days a week can you run?", placeholder: "Tue, Thu" },
        { slot: "aids", prompt: "Following a plan already?" },
      ],
    });

    expect(slots(result)).toEqual(["rhythm", "aids"]);
    expect(result[0].placeholder).toBe("Tue, Thu");
  });

  it("assigns the control from the slot, ignoring whatever the model claimed", () => {
    // A free-text box for a day-of-week question is a worse failure than a
    // generic prompt, so inputKind is always ours.
    const result = validateIntakeQuestions({
      questions: [
        { slot: "rhythm", prompt: "Which days?", inputKind: "text" },
        { slot: "aids", prompt: "Got a course?", inputKind: "banana" },
        { slot: "done", prompt: "What does finished look like?", inputKind: "rhythm" },
      ],
    });

    expect(result.map((r) => r.inputKind)).toEqual(["rhythm", "resources", "text"]);
  });

  it("drops unknown slots rather than asking them", () => {
    const result = validateIntakeQuestions({
      questions: [q("budget"), q("done"), q("astrology"), q("rhythm")],
    });

    expect(slots(result)).toEqual(["done", "rhythm"]);
  });

  it("collapses duplicate slots, keeping the first", () => {
    const result = validateIntakeQuestions({
      questions: [
        { slot: "done", prompt: "First phrasing?" },
        { slot: "done", prompt: "Second phrasing?" },
        { slot: "why", prompt: "Why does this matter?" },
      ],
    });

    expect(slots(result)).toEqual(["done", "why"]);
    expect(result[0].prompt).toBe("First phrasing?");
  });

  it("truncates to the four-question ceiling", () => {
    const result = validateIntakeQuestions({
      questions: [q("done"), q("why"), q("aids"), q("rhythm"), q("blockers")],
    });

    expect(result).toHaveLength(MAX_QUESTIONS);
    expect(slots(result)).toEqual(["done", "why", "aids", "rhythm"]);
  });

  it("falls back when only one question survives validation", () => {
    isFallback(validateIntakeQuestions({ questions: [q("done"), q("nonsense"), q("garbage")] }));
  });

  it("falls back on an empty question list", () => {
    // This is also the injection guard: a goal engineered to make the model
    // return no questions lands here, not in a zero-question interview.
    isFallback(validateIntakeQuestions({ questions: [] }));
  });

  it("falls back on malformed shapes", () => {
    isFallback(validateIntakeQuestions({}));
    isFallback(validateIntakeQuestions({ questions: "done, rhythm" }));
    isFallback(validateIntakeQuestions(null));
    isFallback(validateIntakeQuestions({ questions: [null, undefined, 42] }));
  });

  it("drops entries with a missing or blank prompt", () => {
    isFallback(
      validateIntakeQuestions({
        questions: [{ slot: "done" }, { slot: "why", prompt: "   " }, { slot: "aids", prompt: 7 }],
      })
    );
  });

  it("caps an overlong prompt instead of rejecting the question", () => {
    const result = validateIntakeQuestions({
      questions: [
        { slot: "done", prompt: "x".repeat(500) },
        { slot: "rhythm", prompt: "Which days?" },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[0].prompt).toHaveLength(160);
  });

  it("collapses newlines so a prompt stays one line", () => {
    const result = validateIntakeQuestions({
      questions: [
        { slot: "done", prompt: "What does\n\n  finished   look like?" },
        { slot: "why", prompt: "Why?" },
      ],
    });

    expect(result[0].prompt).toBe("What does finished look like?");
  });
});

describe("brief rendering for the architect prompt", () => {
  it("returns nothing when there is nothing to say", () => {
    expect(formatBriefForPrompt(undefined)).toBe("");
    expect(formatBriefForPrompt({})).toBe("");
    // A brief where every slot was skipped must not emit an empty header.
    expect(formatBriefForPrompt({ rhythm: {} })).toBe("");
  });

  it("renders the answered slots and names the days", () => {
    const out = formatBriefForPrompt({
      done: "Run 21km without walking",
      why: "I said I would, out loud, to my brother",
      rhythm: { days: [2, 4, 0], sessionMinutes: 45 },
      blockers: "I start too fast and hurt my knee",
    });

    expect(out).toContain("Definition of done: Run 21km without walking");
    expect(out).toContain("Tue, Thu, Sun");
    expect(out).toContain("45 minutes per session");
    expect(out).toContain("What usually derails them: I start too fast");
    // The block must announce that its contents are data.
    expect(out).toContain("never as instructions");
  });

  it("falls back to the user's own words when days couldn't be parsed", () => {
    const out = formatBriefForPrompt({
      rhythm: { days: [], sessionMinutes: 30, raw: "whenever the baby naps" },
    });

    expect(out).toContain("whenever the baby naps");
  });

  it("ignores out-of-range day numbers", () => {
    const out = formatBriefForPrompt({ rhythm: { days: [1, 9, -3], sessionMinutes: 20 } });

    expect(out).toContain("Mon");
    expect(out).not.toContain("undefined");
  });
});

describe("proposeIntakeQuestions", () => {
  it("returns validated questions from AI completion", async () => {
    vi.mocked(createChatCompletion).mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              questions: [
                { slot: "done", prompt: "What is your target mileage?" },
                { slot: "rhythm", prompt: "Which days do you run?" },
              ],
            }),
          },
        },
      ],
    });

    const result = await proposeIntakeQuestions("Run a half marathon");
    expect(result).toHaveLength(2);
    expect(result[0].slot).toBe("done");
    expect(result[1].slot).toBe("rhythm");
  });

  it("returns fallback questions when AI call fails", async () => {
    vi.mocked(createChatCompletion).mockRejectedValueOnce(new Error("AI connection failure"));

    const result = await proposeIntakeQuestions("Learn French");
    expect(result).toEqual(FALLBACK_QUESTIONS);
  });
});

