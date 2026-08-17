import { describe, it, expect } from "vitest";
import { safeParseJSON, validateTaskSafety, filterUnsafeTasks } from "./AIHelper.js";

describe("safeParseJSON", () => {
  it("parses valid raw JSON objects and arrays", () => {
    expect(safeParseJSON('{"name": "Quest", "xp": 100}')).toEqual({
      name: "Quest",
      xp: 100,
    });
    expect(safeParseJSON('["task 1", "task 2"]')).toEqual(["task 1", "task 2"]);
  });

  it("strips markdown code fences (```json ... ```)", () => {
    const raw = "```json\n{\n  \"status\": \"ready\",\n  \"count\": 5\n}\n```";
    expect(safeParseJSON(raw)).toEqual({ status: "ready", count: 5 });
  });

  it("strips generic markdown code fences (``` ... ```)", () => {
    const raw = "```\n[\"apple\", \"banana\"]\n```";
    expect(safeParseJSON(raw)).toEqual(["apple", "banana"]);
  });

  it("extracts JSON embedded in conversational commentary", () => {
    const raw = "Here is the requested plan:\n{\n  \"title\": \"Run 5k\"\n}\nHope this helps!";
    expect(safeParseJSON(raw)).toEqual({ title: "Run 5k" });
  });

  it("handles trailing commas in objects and arrays", () => {
    const raw = '{"a": 1, "b": 2, }';
    expect(safeParseJSON(raw)).toEqual({ a: 1, b: 2 });

    const arrayRaw = '["item 1", "item 2", ]';
    expect(safeParseJSON(arrayRaw)).toEqual(["item 1", "item 2"]);
  });

  it("normalizes smart/curly quotes", () => {
    const raw = '{\u201Ctitle\u201D: \u201CLevel Up\u201D}';
    expect(safeParseJSON(raw)).toEqual({ title: "Level Up" });
  });

  it("returns fallback on completely invalid input or null", () => {
    expect(safeParseJSON("not json at all", { default: true })).toEqual({ default: true });
    expect(safeParseJSON(null, [])).toEqual([]);
    expect(safeParseJSON(undefined)).toBeNull();
  });
});

describe("task safety validation", () => {
  it("allows safe tasks", () => {
    expect(validateTaskSafety("Go for a 20-minute jog")).toBe(true);
    expect(validateTaskSafety("Read chapter 4 of clean code")).toBe(true);
  });

  it("flags unsafe or restricted tasks", () => {
    expect(validateTaskSafety("Prescribe medication for fever")).toBe(false);
    expect(validateTaskSafety("Invest in volatile penny stocks")).toBe(false);
    expect(validateTaskSafety("Ways to self-harm")).toBe(false);
  });

  it("filters out unsafe tasks from lists", () => {
    const tasks = [
      { title: "Safe task 1" },
      { title: "Prescribe antibiotic" },
      { title: "Safe task 2" },
    ];
    const filtered = filterUnsafeTasks(tasks);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((t) => t.title)).toEqual(["Safe task 1", "Safe task 2"]);
  });
});
