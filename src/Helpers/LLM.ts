import "dotenv/config";
import {
  MODEL_CHAIN,
  PROVIDERS,
  type ModelTier,
  type ModelTarget,
} from "../config/models.js";

export interface ChatMessageContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatMessageContentPart[];
}

export interface ChatCompletionOptions {
  model: ModelTier;
  messages: ChatMessage[];
  temperature?: number;
  max_completion_tokens?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "text" };
  top_p?: number;
  timeoutMs?: number;
}

export interface ChatCompletionChoice {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
  };
  finish_reason?: string;
}

export interface ChatCompletionResponse {
  id?: string;
  provider?: string;
  model?: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Execute a chat completion across an ordered failover chain of model targets.
 * Falls through on HTTP error codes (429, 503, 500, 400), network timeouts,
 * or invalid provider keys.
 */
export async function createChatCompletion(
  options: ChatCompletionOptions
): Promise<ChatCompletionResponse> {
  const chain: ModelTarget[] = MODEL_CHAIN[options.model];
  if (!chain || chain.length === 0) {
    throw new Error(`[LLM] No model targets configured for tier: "${options.model}"`);
  }

  const requestedTokens = options.max_completion_tokens ?? options.max_tokens;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const errors: Array<{ target: string; error: string }> = [];

  for (const target of chain) {
    const providerConfig = PROVIDERS[target.provider];
    if (!providerConfig) {
      errors.push({
        target: `${target.provider}/${target.model}`,
        error: `Unknown provider: ${target.provider}`,
      });
      continue;
    }

    const apiKey = process.env[providerConfig.apiKeyEnv];
    if (!apiKey) {
      errors.push({
        target: `${target.provider}/${target.model}`,
        error: `Missing environment variable: ${providerConfig.apiKeyEnv}`,
      });
      continue;
    }

    // Clamp token ceiling to target's supported output capacity
    const effectiveTokens = requestedTokens
      ? Math.min(requestedTokens, target.maxOutputTokens)
      : target.maxOutputTokens;

    const requestBody: Record<string, any> = {
      model: target.model,
      messages: options.messages,
      [providerConfig.maxTokensParam]: effectiveTokens,
    };

    if (options.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }
    if (options.top_p !== undefined) {
      requestBody.top_p = options.top_p;
    }
    if (options.response_format !== undefined) {
      requestBody.response_format = options.response_format;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    if (target.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://shard.quest";
      headers["X-Title"] = "Shard";
    }

    const url = `${providerConfig.baseURL}/chat/completions`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        const msg = `HTTP ${response.status}: ${errorBody.slice(0, 300)}`;
        console.warn(
          `[LLM] Target ${target.provider}/${target.model} failed: ${msg}. Attempting fallback...`
        );
        errors.push({
          target: `${target.provider}/${target.model}`,
          error: msg,
        });
        continue;
      }

      const data = (await response.json()) as ChatCompletionResponse;
      if (!data?.choices || data.choices.length === 0) {
        const msg = "Invalid response: empty choices array";
        console.warn(
          `[LLM] Target ${target.provider}/${target.model} returned malformed data: ${msg}. Attempting fallback...`
        );
        errors.push({
          target: `${target.provider}/${target.model}`,
          error: msg,
        });
        continue;
      }

      return data;
    } catch (err: any) {
      const isAbort = err?.name === "AbortError";
      const msg = isAbort ? `Timeout after ${timeoutMs}ms` : err?.message || String(err);
      console.warn(
        `[LLM] Target ${target.provider}/${target.model} error: ${msg}. Attempting fallback...`
      );
      errors.push({
        target: `${target.provider}/${target.model}`,
        error: msg,
      });
    }
  }

  const failureSummary = errors
    .map((e) => `• ${e.target}: ${e.error}`)
    .join("\n");
  throw new Error(
    `[LLM] All model targets in chain for tier '${options.model}' failed:\n${failureSummary}`
  );
}
