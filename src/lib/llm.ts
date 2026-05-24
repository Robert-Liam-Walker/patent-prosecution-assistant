import { togetherai } from "@ai-sdk/togetherai";

// Qwen2.5-72B-Instruct on Together AI.
// Pricing as of 2026-05: ~$0.30 in / $0.40 out per M tokens.
export const chatModel = togetherai("Qwen/Qwen2.5-72B-Instruct-Turbo");

// Smaller cheaper variant for classification/routing tasks
export const fastModel = togetherai("Qwen/Qwen2.5-7B-Instruct-Turbo");
