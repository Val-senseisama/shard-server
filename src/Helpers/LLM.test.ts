import "dotenv/config";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createChatCompletion } from "./LLM.js";

describe("LLM createChatCompletion", () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = "test_groq_key";
    process.env.OPENROUTER_API_KEY = "test_openrouter_key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("completes successfully using the primary target (Groq)", async () => {
    const mockResponse = {
      choices: [{ message: { role: "assistant", content: "Hello from Groq" } }],
    };

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createChatCompletion({
      model: "heavy",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.choices[0]?.message?.content).toBe("Hello from Groq");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const body = JSON.parse(req.body);
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.max_completion_tokens).toBe(4096);
  });

  it("clamps requested max tokens to target maxOutputTokens", async () => {
    const mockResponse = {
      choices: [{ message: { role: "assistant", content: "Clamped" } }],
    };

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });
    vi.stubGlobal("fetch", fetchMock);

    // Requesting 8192 on heavy tier (where Groq cap is 4096)
    await createChatCompletion({
      model: "heavy",
      messages: [{ role: "user", content: "Hi" }],
      max_completion_tokens: 8192,
    });

    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req.body);
    expect(body.max_completion_tokens).toBe(4096);
  });

  it("falls back to OpenRouter when primary target fails with 429 or 503", async () => {
    const fallbackResponse = {
      choices: [{ message: { role: "assistant", content: "Hello from OpenRouter" } }],
    };

    const fetchMock = vi
      .fn()
      // First call (Groq) fails with 429 rate limit
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Rate limit reached",
      })
      // Second call (OpenRouter) succeeds
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fallbackResponse,
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createChatCompletion({
      model: "heavy",
      messages: [{ role: "user", content: "Hi" }],
      max_completion_tokens: 8192,
    });

    expect(result.choices[0]?.message?.content).toBe("Hello from OpenRouter");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [openRouterUrl, openRouterReq] = fetchMock.mock.calls[1];
    expect(openRouterUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(openRouterReq.headers["Authorization"]).toBe("Bearer test_openrouter_key");
    expect(openRouterReq.headers["HTTP-Referer"]).toBe("https://shard.quest");

    const body = JSON.parse(openRouterReq.body);
    expect(body.model).toBe("openai/gpt-4o-mini");
    // OpenRouter target supports 8192 tokens and uses max_tokens parameter
    expect(body.max_tokens).toBe(8192);
  });

  it("falls back when primary target encounters network error", async () => {
    const fallbackResponse = {
      choices: [{ message: { role: "assistant", content: "Fallback success" } }],
    };

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fallbackResponse,
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createChatCompletion({
      model: "light",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.choices[0]?.message?.content).toBe("Fallback success");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws diagnostic error when all targets in the chain fail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Groq Error",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "OpenRouter Service Unavailable",
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createChatCompletion({
        model: "heavy",
        messages: [{ role: "user", content: "Hi" }],
      })
    ).rejects.toThrow(/All model targets in chain for tier 'heavy' failed/);
  });
});
