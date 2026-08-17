/**
 * Watching a plan get built, instead of watching a spinner lie.
 *
 * `AILoadingView` used to cycle five invented status messages for up to thirty
 * seconds — the most rigid moment in the product, because the user is locked out
 * while something happens *to* them. Streaming turns that dead time into the
 * plan appearing phase by phase, and it means a visibly wrong plan can be
 * abandoned at phase two rather than after the whole wait.
 *
 * The mechanism is deliberately unglamorous: the model emits one JSON object,
 * we accumulate the text, and a brace-depth scanner pulls out each mini-quest
 * the moment its closing brace arrives. No partial-JSON parser, no dependency —
 * a depth counter that knows how to ignore braces inside strings.
 */

import { PROVIDERS, MODEL_CHAIN, type ModelTarget, type ModelTier } from "../config/models.js";
import { logError } from "./Helpers.js";

export interface StreamedPhase {
  title: string;
  stepCount: number;
  estimatedDuration?: string;
}

/**
 * Pulls complete `miniQuests` entries out of a growing JSON string.
 *
 * Stateful across chunks: `push` returns whatever became complete since the last
 * call, which for a typical plan is one phase every few hundred tokens.
 */
export class PhaseExtractor {
  private buffer = "";
  private cursor = 0;
  private started = false;

  /** Feed a chunk; get back any phases that completed inside it. */
  push(chunk: string): StreamedPhase[] {
    this.buffer += chunk;

    if (!this.started) {
      const at = this.buffer.indexOf('"miniQuests"');
      if (at === -1) return [];
      const open = this.buffer.indexOf("[", at);
      if (open === -1) return [];
      this.cursor = open + 1;
      this.started = true;
    }

    const found: StreamedPhase[] = [];

    // Scan from the cursor for balanced top-level objects. Anything before the
    // cursor has already been emitted, so this never re-reports a phase.
    let depth = 0;
    let objectStart = -1;
    let inString = false;
    let escaped = false;

    for (let i = this.cursor; i < this.buffer.length; i++) {
      const ch = this.buffer[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "{") {
        if (depth === 0) objectStart = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && objectStart !== -1) {
          const phase = this.parse(this.buffer.slice(objectStart, i + 1));
          if (phase) found.push(phase);
          // Only advance past objects we've fully consumed — a chunk that ends
          // mid-object must be re-scanned from the same point next time.
          this.cursor = i + 1;
          objectStart = -1;
        }
      } else if (ch === "]" && depth === 0) {
        // End of the array; nothing further to extract.
        this.cursor = this.buffer.length;
        break;
      }
    }

    return found;
  }

  /** The whole response so far, for the caller's own final parse. */
  text(): string {
    return this.buffer;
  }

  private parse(json: string): StreamedPhase | null {
    try {
      const o = JSON.parse(json);
      if (!o?.title) return null;
      return {
        title: o.title,
        stepCount: Array.isArray(o.steps) ? o.steps.length : 0,
        estimatedDuration: o.estimatedDuration,
      };
    } catch {
      return null;
    }
  }
}

export interface StreamOptions {
  model: ModelTier;
  messages: { role: string; content: string }[];
  temperature?: number;
  max_completion_tokens?: number;
  response_format?: { type: "json_object" | "text" };
  timeoutMs?: number;
  /** Called as each phase completes. Never throws into the stream. */
  onPhase?: (phase: StreamedPhase, index: number) => void;
}

/**
 * Stream one completion, reporting phases as they land.
 *
 * Returns the full text so the caller parses the finished object exactly as it
 * would have without streaming — the events are a side channel, never the source
 * of truth for what gets saved.
 *
 * Only the FIRST target in the chain is streamed. If it fails, the caller falls
 * back to the ordinary non-streaming path, which has the full failover chain.
 * Streaming is a nicety; availability is not.
 */
export async function streamChatCompletion(options: StreamOptions): Promise<string | null> {
  const chain: ModelTarget[] = MODEL_CHAIN[options.model];
  const target = chain?.[0];
  if (!target) return null;

  const provider = PROVIDERS[target.provider];
  const apiKey = provider && process.env[provider.apiKeyEnv];
  if (!provider || !apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 45000);

  try {
    const res = await fetch(`${provider.baseURL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: target.model,
        messages: options.messages,
        stream: true,
        temperature: options.temperature,
        [provider.maxTokensParam]: Math.min(
          options.max_completion_tokens ?? target.maxOutputTokens,
          target.maxOutputTokens
        ),
        ...(options.response_format ? { response_format: options.response_format } : {}),
      }),
    });

    if (!res.ok || !res.body) return null;

    const extractor = new PhaseExtractor();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let phaseIndex = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      // SSE frames are newline-delimited; a chunk can split one in half.
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;

        let delta = "";
        try {
          delta = JSON.parse(payload)?.choices?.[0]?.delta?.content ?? "";
        } catch {
          continue; // a malformed frame is not worth failing the stream over
        }
        if (!delta) continue;

        for (const phase of extractor.push(delta)) {
          // A subscriber throwing must not kill the generation.
          try {
            options.onPhase?.(phase, phaseIndex++);
          } catch {
            /* ignore */
          }
        }
      }
    }

    const text = extractor.text();
    return text.length > 0 ? text : null;
  } catch (error) {
    logError("streamChatCompletion", error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
