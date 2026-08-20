// Embeddings via the Voyage AI REST API.
//
// Why not Anthropic: Anthropic ships no embedding model. @ai-sdk/anthropic
// types embeddingModel() as returning `never` and throws NoSuchModelError at
// runtime, so retrieval necessarily runs on a separate provider from
// generation. Voyage is Anthropic's documented recommendation.
//
// Why voyage-law-2: legal-domain tuned, and 1024 dims fixed -- which matches
// chunks.embedding vector(1024) exactly, so no schema migration is needed.
// Override with VOYAGE_EMBED_MODEL to A/B against a newer general model; if
// that model has a configurable output dimension, VOYAGE_OUTPUT_DIMENSION must
// be set to 1024 or the write will fail against the column.
//
// Called via REST rather than through an AI SDK provider: the request shape is
// a single POST, and this avoids taking a dependency on a community provider
// package for two functions.

// EMBED_PROVIDER selects the backend. It exists so the Claude migration and the
// embedding migration can be measured separately: flipping both at once would
// make any change in eval scores unattributable. Set EMBED_PROVIDER=ollama to
// keep retrieval on the vectors already in the database.
const PROVIDER = (process.env.EMBED_PROVIDER ?? "voyage").toLowerCase();

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const OLLAMA_URL =
  (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1") + "/embeddings";
const OLLAMA_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "mxbai-embed-large";
const EMBED_MODEL =
  PROVIDER === "ollama" ? OLLAMA_MODEL : (process.env.VOYAGE_EMBED_MODEL ?? "voyage-law-2");
const OUTPUT_DIMENSION = process.env.VOYAGE_OUTPUT_DIMENSION
  ? Number(process.env.VOYAGE_OUTPUT_DIMENSION)
  : undefined;

/** The dimension chunks.embedding is declared with. A mismatch is a hard error. */
export const EXPECTED_DIMENSIONS = 1024;

// Voyage accepts at most 128 inputs per request, but the per-minute TOKEN
// limit binds first on the free tier (10K TPM without a payment method on
// file). 24 chunks of ~250 tokens stays under that; override once the account
// has standard limits.
const MAX_BATCH = Number(process.env.VOYAGE_MAX_BATCH ?? 24);

// Spacing between requests. The free tier allows 3 RPM, i.e. one request per
// 20s. Set VOYAGE_DELAY_MS=0 on a paid account.
const DELAY_MS = Number(process.env.VOYAGE_DELAY_MS ?? 21_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Voyage embeds queries and documents asymmetrically: passing the right
 * input_type measurably improves retrieval over embedding both sides
 * identically, which is what the previous Ollama setup did.
 */
type InputType = "query" | "document";

type VoyageResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
};

function apiKey(): string {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new Error(
      "VOYAGE_API_KEY is not set. Embeddings (and therefore all retrieval) " +
        "require it -- see .env.example.",
    );
  }
  return key;
}

async function callVoyage(input: string[], inputType: InputType): Promise<number[][]> {
  // Rate limits are a normal operating condition here, not an error: the free
  // tier is 3 RPM / 10K TPM. Back off and retry rather than failing a whole
  // ingest or a user's document upload on the first 429.
  const MAX_RETRIES = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      return await callVoyageOnce(input, inputType);
    } catch (err) {
      const is429 = err instanceof Error && err.message.includes("(429)");
      if (!is429 || attempt > MAX_RETRIES) throw err;
      const backoff = DELAY_MS > 0 ? DELAY_MS : 2_000 * 2 ** (attempt - 1);
      console.warn(`[embed] rate limited, retrying in ${Math.round(backoff / 1000)}s (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(backoff);
    }
  }
}

async function callVoyageOnce(input: string[], inputType: InputType): Promise<number[][]> {
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      input,
      model: EMBED_MODEL,
      input_type: inputType,
      ...(OUTPUT_DIMENSION ? { output_dimension: OUTPUT_DIMENSION } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Voyage embeddings failed (${res.status}): ${body.slice(0, 400)}`);
  }

  const json = (await res.json()) as VoyageResponse;
  if (!json.data || json.data.length !== input.length) {
    throw new Error(
      `Voyage returned ${json.data?.length ?? 0} embeddings for ${input.length} inputs`,
    );
  }

  // Voyage does not guarantee response order; it returns an explicit index.
  const ordered = new Array<number[]>(input.length);
  for (const d of json.data) ordered[d.index] = d.embedding;

  // Fail loudly on a dimension mismatch rather than writing rows that break
  // the HNSW index or silently degrade cosine search.
  const dim = ordered[0]?.length;
  if (dim !== EXPECTED_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch: ${EMBED_MODEL} returned ${dim} dims, ` +
        `but chunks.embedding is vector(${EXPECTED_DIMENSIONS}). Either pick a ` +
        `1024-d model or set VOYAGE_OUTPUT_DIMENSION=1024 if this model supports it.`,
    );
  }

  return ordered;
}

/**
 * Legacy Ollama path, retained only so the pre-Voyage vectors remain queryable
 * while the two migrations are evaluated one at a time. Ollama embeds queries
 * and documents identically -- input_type has no analogue there.
 */
async function callOllama(input: string[]): Promise<number[][]> {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer ollama" },
    body: JSON.stringify({ input, model: OLLAMA_MODEL }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embeddings failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as VoyageResponse;
  const ordered = new Array<number[]>(input.length);
  for (const d of json.data) ordered[d.index] = d.embedding;
  return ordered;
}

async function callProvider(input: string[], inputType: InputType): Promise<number[][]> {
  return PROVIDER === "ollama" ? callOllama(input) : callVoyage(input, inputType);
}

/** Embed a search query. On Voyage this uses input_type=query (asymmetric). */
export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await callProvider([text], "query");
  return embedding;
}

/** Embed corpus/document chunks. Batches to Voyage's per-request limit. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    if (i > 0 && PROVIDER !== "ollama" && DELAY_MS > 0) await sleep(DELAY_MS);
    out.push(...(await callProvider(texts.slice(i, i + MAX_BATCH), "document")));
  }
  return out;
}

export const EMBED_MODEL_ID = EMBED_MODEL;
