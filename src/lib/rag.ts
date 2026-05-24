// Two-index RAG: global corpus (case_id IS NULL) + per-case docs.
// Single query returns both, tagged by origin.

import { db, schema } from "@/lib/db";
import { embedQuery } from "@/lib/embed";
import { sql } from "drizzle-orm";

export interface RetrievedChunk {
  id: string;
  text: string;
  source: string;
  sourceUrl: string | null;
  citation: string;
  docType: string;
  origin: "global" | "case";
  similarity: number;
}

export async function retrieve(
  query: string,
  opts: { caseId?: string | null; k?: number } = {},
): Promise<RetrievedChunk[]> {
  const k = opts.k ?? 8;
  const queryEmbedding = await embedQuery(query);
  const literal = `[${queryEmbedding.join(",")}]`;

  // Filter: global rows OR rows belonging to the active case.
  const caseFilter = opts.caseId
    ? sql`(${schema.chunks.caseId} IS NULL OR ${schema.chunks.caseId} = ${opts.caseId})`
    : sql`${schema.chunks.caseId} IS NULL`;

  const rows = await db
    .select({
      id: schema.chunks.id,
      text: schema.chunks.text,
      source: schema.chunks.source,
      sourceUrl: schema.chunks.sourceUrl,
      citation: schema.chunks.citation,
      docType: schema.chunks.docType,
      caseId: schema.chunks.caseId,
      similarity: sql<number>`1 - (${schema.chunks.embedding} <=> ${literal}::vector)`,
    })
    .from(schema.chunks)
    .where(caseFilter)
    .orderBy(sql`${schema.chunks.embedding} <=> ${literal}::vector`)
    .limit(k);

  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    source: r.source,
    sourceUrl: r.sourceUrl,
    citation: r.citation,
    docType: r.docType,
    origin: r.caseId ? "case" : "global",
    similarity: Number(r.similarity),
  }));
}

export function formatContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (c, i) =>
        `[Source ${i + 1}] (${c.origin}, ${c.docType}) ${c.citation}\n${c.text}`,
    )
    .join("\n\n---\n\n");
}
