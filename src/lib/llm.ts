import { createAnthropic } from "@ai-sdk/anthropic";
import type { JSONObject } from "@ai-sdk/provider";

// Hosted Claude via the Anthropic API. Reads ANTHROPIC_API_KEY from the env.
//
// Compute is tiered by task rather than using one model everywhere: legal
// reasoning (claim-by-claim §102/§103 analysis, patent drafting) gets Opus at
// xhigh effort, routine drafting gets Sonnet, and mechanical formatting gets
// Haiku. Effort is the per-request compute dial and is the thing local Ollama
// had no analogue for -- see backlog items 4b/4c for why 8B was the ceiling.
const anthropic = createAnthropic();

const OPUS = process.env.ANTHROPIC_REASONING_MODEL ?? "claude-opus-5";
const SONNET = process.env.ANTHROPIC_DRAFTING_MODEL ?? "claude-sonnet-5";
const HAIKU = process.env.ANTHROPIC_UTILITY_MODEL ?? "claude-haiku-4-5";

/**
 * A task profile bundles the model with its call-time settings so the tiering
 * lives in one place. Spread it into generateObject/generateText/streamText:
 *
 *   await generateObject({ ...REASONING, schema, system, prompt })
 */
export type TaskProfile = {
  model: ReturnType<typeof anthropic>;
  maxOutputTokens: number;
  providerOptions: Record<string, JSONObject>;
};

// maxOutputTokens caps thinking AND response text together. Thinking is on by
// default on Opus 5, so these are sized well above the expected JSON payload
// (a rejection analysis is ~2-4k tokens) to leave the model room to reason.
// If a call ever returns truncated, raise this before touching effort --
// and if raising it starts causing HTTP timeouts, switch that call site to
// streamObject rather than trading away reasoning depth.

/** Opus at xhigh -- §102/§103 analysis, amendment drafting, application drafting. */
export const REASONING: TaskProfile = {
  model: anthropic(OPUS),
  maxOutputTokens: 32000,
  providerOptions: {
    anthropic: {
      effort: "xhigh",
      thinking: { type: "adaptive" },
    },
  },
};

/** Sonnet at high -- structured drafting where the legal reasoning is lighter. */
export const DRAFTING: TaskProfile = {
  model: anthropic(SONNET),
  maxOutputTokens: 16000,
  providerOptions: {
    anthropic: {
      effort: "high",
      thinking: { type: "adaptive" },
    },
  },
};

/** Sonnet at medium -- freeform prose (client email), grounded chat. */
export const FAST: TaskProfile = {
  model: anthropic(SONNET),
  maxOutputTokens: 8000,
  providerOptions: {
    anthropic: {
      effort: "medium",
      thinking: { type: "adaptive" },
    },
  },
};

// Haiku 4.5 predates the effort parameter and rejects it, and it does not
// support adaptive thinking -- so this profile deliberately sets neither.
// Reformatting a USPTO JSON blob into a status card needs no reasoning budget.
/** Haiku -- mechanical formatting, no reasoning required. */
export const UTILITY: TaskProfile = {
  model: anthropic(HAIKU),
  maxOutputTokens: 4000,
  providerOptions: {},
};

/**
 * Cache breakpoint for the long, byte-stable system prompt. Opus 5 caches from
 * 512 tokens and cache reads cost ~0.1x, so every call after the first pays a
 * tenth for the prompt prefix. Attach to the system message, not the user turn:
 * the user turn changes every request and would never hit.
 */
export const SYSTEM_CACHE_CONTROL = { type: "ephemeral" as const };

/** Back-compat alias for the freeform chat route. */
export const chatModel = FAST.model;
