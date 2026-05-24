import { and, eq, isNull } from "drizzle-orm";

export const GLOBAL_DOC_TYPES = [
  "mpep",
  "patent",
  "patent_application",
  "ptab_decision",
  "fed_circuit",
  "usc",
  "cfr",
] as const;

export type GlobalDocType = (typeof GLOBAL_DOC_TYPES)[number];

export type IngestTextSource = {
  text: string;
  docType: GlobalDocType;
  source: string;
  citation: string;
  sourceUrl?: string | null;
};

export type IngestOptions = {
  sources: IngestTextSource[];
  batchSize: number;
  clearExisting: boolean;
  dryRun: boolean;
};

export function parseGlobalDocType(value: string | undefined): GlobalDocType {
  if (!value) {
    throw new Error("--doc-type is required.");
  }

  if (GLOBAL_DOC_TYPES.includes(value as GlobalDocType)) {
    return value as GlobalDocType;
  }

  throw new Error(
    `Unsupported --doc-type "${value}". Expected one of: ${GLOBAL_DOC_TYPES.join(", ")}`,
  );
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("Expected a positive integer.");
  }
  return parsed;
}

export async function ingestTextSources({
  sources,
  batchSize,
  clearExisting,
  dryRun,
}: IngestOptions): Promise<number> {
  const [{ db, schema }, { chunkText }, { embedBatch }] = await Promise.all([
    import("../../src/lib/db/index"),
    import("../../src/lib/chunk"),
    import("../../src/lib/embed"),
  ]);

  let totalChunks = 0;

  for (const source of sources) {
    const chunks = chunkText(source.text, source.source);
    totalChunks += chunks.length;

    console.log(`[ingest] ${source.source}: ${chunks.length} chunk(s)`);

    if (dryRun || chunks.length === 0) {
      continue;
    }

    if (clearExisting) {
      await db
        .delete(schema.chunks)
        .where(
          and(
            isNull(schema.chunks.caseId),
            eq(schema.chunks.docType, source.docType),
            eq(schema.chunks.source, source.source),
          ),
        );
    }

    for (let start = 0; start < chunks.length; start += batchSize) {
      const batch = chunks.slice(start, start + batchSize);
      const embeddings = await embedBatch(batch.map((chunk) => chunk.text));

      if (embeddings.length !== batch.length) {
        throw new Error(
          `Embedding count mismatch for ${source.source}: expected ${batch.length}, got ${embeddings.length}`,
        );
      }

      await db.insert(schema.chunks).values(
        batch.map((chunk, i) => ({
          caseId: null,
          userId: null,
          docId: null,
          docType: source.docType,
          source: source.source,
          sourceUrl: source.sourceUrl ?? null,
          citation: `${source.citation} (chunk ${chunk.index + 1})`,
          text: chunk.text,
          embedding: embeddings[i],
        })),
      );
    }
  }

  return totalChunks;
}
