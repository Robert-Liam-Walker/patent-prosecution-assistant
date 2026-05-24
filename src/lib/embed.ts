import { openai } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";

const model = openai.textEmbeddingModel("text-embedding-3-small");

export async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await embed({ model, value: text });
  return embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({ model, values: texts });
  return embeddings;
}
