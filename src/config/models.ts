/**
 * LLM providers and model chains — the single place they're written down.
 *
 * Two things forced this shape:
 *
 *  1. On 2026-08-17 Groq decommissioned `llama-3.3-70b-versatile` and
 *     `llama-3.1-8b-instant`, taking quest creation down in production. The ids
 *     were hardcoded in three places, so the fix meant hunting them.
 *  2. Every model we can currently afford is on someone's free tier, and free
 *     tiers ration: Groq rejects large requests outright, OpenRouter's `:free`
 *     variants are best-effort and return 503 under load (observed on
 *     `z-ai/glm-5.2:free`, which failed every probe).
 *
 * So a tier is not one model — it's an ORDERED CHAIN. `Helpers/LLM.ts` walks it
 * and uses the first target that answers. One provider being rationed or down
 * degrades latency, not availability.
 *
 * Verify ids against the provider before editing; a model in the docs is not
 * necessarily one this account is entitled to:
 *   curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
 *   curl https://openrouter.ai/api/v1/models
 */

export type ProviderId = "groq" | "openrouter";

export interface ProviderConfig {
  baseURL: string;
  apiKeyEnv: string;
  /**
   * Groq speaks `max_completion_tokens`; OpenRouter speaks `max_tokens`. Both
   * are otherwise OpenAI-shaped, which is why one fetch client serves both.
   */
  maxTokensParam: "max_completion_tokens" | "max_tokens";
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    maxTokensParam: "max_completion_tokens",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    maxTokensParam: "max_tokens",
  },
};

/**
 * `heavy` and `light` are the only model names the app uses. Call sites ask for
 * a capability, never a vendor — swapping providers is an edit here alone.
 */
export type ModelTier = "heavy" | "light" | "vision";

export interface ModelTarget {
  provider: ProviderId;
  model: string;
  /**
   * Ceiling for this target's output. Groq free rejects oversized requests with
   * "request too large" rather than truncating, so the cap is per-target, not
   * per-call — a call asking for more is clamped, not failed.
   */
  maxOutputTokens: number;
}

/**
 * Tried and verified with real live calls:
 *   groq/gpt-oss-120b                      ~900ms   (primary heavy, free)
 *   groq/gpt-oss-20b                       ~400ms   (primary light, free)
 *   openrouter/openai/gpt-4o-mini          ~850ms   (ultra-reliable, multimodal, $0.15/M)
 *   openrouter/meta-llama/llama-3.3-70b    ~900ms   (open weights fallback, $0.12/M)
 *   openrouter/deepseek/deepseek-chat      ~1400ms  (reasoning fallback, $0.14/M)
 *   openrouter/openai/gpt-oss-20b:free     ~1200ms  (free backup)
 *   openrouter/nemotron-3-super-120b:free  ~2000ms  (free backup)
 */
export const MODEL_CHAIN: Record<ModelTier, ModelTarget[]> = {
  heavy: [
    { provider: "groq", model: "openai/gpt-oss-120b", maxOutputTokens: 4096 },
    {
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      maxOutputTokens: 8192,
    },
    {
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
      maxOutputTokens: 8192,
    },
    {
      provider: "openrouter",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      maxOutputTokens: 8192,
    },
  ],
  light: [
    { provider: "groq", model: "openai/gpt-oss-20b", maxOutputTokens: 2048 },
    {
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      maxOutputTokens: 2048,
    },
    {
      provider: "openrouter",
      model: "openai/gpt-oss-20b:free",
      maxOutputTokens: 2048,
    },
    {
      provider: "openrouter",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      maxOutputTokens: 2048,
    },
  ],
  vision: [
    {
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      maxOutputTokens: 4096,
    },
    {
      provider: "openrouter",
      model: "google/gemma-4-31b-it:free",
      maxOutputTokens: 4096,
    },
    {
      provider: "openrouter",
      model: "nvidia/nemotron-nano-12b-v2-vl:free",
      maxOutputTokens: 4096,
    },
  ],
};

/** What call sites pass as `model`. Resolved to a chain by Helpers/LLM.ts. */
export const HEAVY_MODEL: ModelTier = "heavy";
export const LIGHT_MODEL: ModelTier = "light";
export const VISION_MODEL: ModelTier = "vision";


