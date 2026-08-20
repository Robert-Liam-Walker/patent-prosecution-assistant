// Guards against querying a vector store that was written by a different
// embedding model than the one now configured.
//
// This is not a theoretical concern: switching src/lib/embed.ts from Ollama to
// Voyage without re-embedding leaves 1024-d vectors from mxbai-embed-large in
// the table while queries are embedded by voyage-law-2. Both are 1024-d, so
// every type check and every SQL constraint passes -- the search just returns
// meaningless neighbours. Checked once per process, then cached.

import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { EMBED_MODEL_ID, EXPECTED_DIMENSIONS } from "@/lib/embed";

let verified: Promise<void> | null = null;

async function check(): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.embeddingMeta)
    .where(eq(schema.embeddingMeta.id, "current"))
    .limit(1);

  if (!row) {
    throw new Error(
      `No embedding provenance recorded. The vectors in \`chunks\` were written ` +
        `by an unknown model, but queries are now embedded with ${EMBED_MODEL_ID}. ` +
        `Run: npm run reembed  (then retry)`,
    );
  }

  if (row.model !== EMBED_MODEL_ID) {
    throw new Error(
      `Embedding model mismatch. Stored vectors were written by "${row.model}" ` +
        `but queries are embedded with "${EMBED_MODEL_ID}". Cosine similarity ` +
        `across different embedding spaces is meaningless, so retrieval would ` +
        `silently return wrong sources. Run: npm run reembed`,
    );
  }

  if (row.dimensions !== EXPECTED_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch: stored ${row.dimensions}, expected ` +
        `${EXPECTED_DIMENSIONS}. Run: npm run reembed`,
    );
  }
}

/** Verify once per process that stored vectors match the configured model. */
export function assertEmbeddingsMatch(): Promise<void> {
  if (!verified) {
    verified = check().catch((e) => {
      verified = null; // let a later call retry after the operator fixes it
      throw e;
    });
  }
  return verified;
}
