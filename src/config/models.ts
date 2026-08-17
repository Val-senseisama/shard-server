/**
 * The LLM model ids — the single place they're written down.
 *
 * On 2026-08-17 Groq decommissioned `llama-3.3-70b-versatile` AND
 * `llama-3.1-8b-instant`, which took quest creation down in production with
 * `model_not_found`. The ids were hardcoded in three places across two files, so
 * fixing it meant hunting them; the point of this file is that next time it's
 * one line.
 *
 * Provider model ids churn on weeks-to-months notice. When a deprecation email
 * arrives, verify what the account can actually see before editing:
 *
 *   curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
 *
 * That endpoint is authoritative for THIS account — a model in the public docs
 * is not necessarily one you're entitled to.
 */

/** Full reasoning: quest breakdowns, coach replies. Quality over latency. */
export const HEAVY_MODEL = "openai/gpt-oss-120b";

/** Fast and cheap: nudges, summaries, tips, intake question selection. */
export const LIGHT_MODEL = "openai/gpt-oss-20b";

// No vision model: nothing in the app sends images to an LLM, and nothing this
// account can currently see would accept one. Noted in PLAN-intake.md §5.4,
// which is the only thing that wanted it.
