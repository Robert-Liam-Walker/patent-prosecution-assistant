import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embed, embedMany } from "ai";

// Local Ollama embeddings via OpenAI-compatible endpoint.
// mxbai-embed-large is 1024 dims, matching the chunks.embedding schema.
const baseURL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";

const provider = createOpenAICompatible({
  name: "ollama",
  baseURL,
  apiKey: "ollama",
});

const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "mxbai-embed-large";

const model = provider.textEmbeddingModel(EMBED_MODEL);

export async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await embed({ model, value: text });
  return embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({ model, values: texts });
  return embeddings;
}
