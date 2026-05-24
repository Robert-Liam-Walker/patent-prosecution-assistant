import { togetherai } from "@ai-sdk/togetherai";
import { embed, embedMany } from "ai";

// BGE-large-en-v1.5 on Together AI. 1024 dims. ~$0.008/M tokens.
// Same provider as the Qwen chat model → one API key for the whole stack.
// (Qwen3-Embedding isn't hosted on Together AI — would need DashScope for strict-Qwen.)
const model = togetherai.textEmbeddingModel("BAAI/bge-large-en-v1.5");

export async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await embed({ model, value: text });
  return embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({ model, values: texts });
  return embeddings;
}
