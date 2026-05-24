import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// Local Ollama via its OpenAI-compatible endpoint.
// To swap to real OpenAI/Anthropic later: replace this provider with
// `@ai-sdk/openai` or `@ai-sdk/anthropic` and adjust model IDs.
const baseURL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";

const provider = createOpenAICompatible({
  name: "ollama",
  baseURL,
  // Ollama doesn't require auth; SDK requires a non-empty string.
  apiKey: "ollama",
});

const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL ?? "llama3.1:8b";
const FAST_MODEL = process.env.OLLAMA_FAST_MODEL ?? "llama3.1:8b";

export const chatModel = provider.chatModel(CHAT_MODEL);
export const fastModel = provider.chatModel(FAST_MODEL);
