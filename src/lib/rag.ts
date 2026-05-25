// Two-index RAG with per-scope budgets.
//
// Cosine-only retrieval over (global ∪ case) loses badly when the user's
// query phrasing matches generic statute/MPEP language more strongly than
// the case docs (eg. "§ 102 anticipation" returns 8 MPEP chunks and drops
// claims.txt). We split the retrieval into two scoped queries with
// separate top-k budgets so case docs always get their guaranteed slots
// when a case is active.

import { db, schema } from "@/lib/db";
import { embedQuery } from "@/lib/embed";
import { and, eq, isNull, sql } from "drizzle-orm";

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

export type RetrieveOptions = {
  caseId?: string | null;
  kGlobal?: number;
  kCase?: number;
  /** @deprecated Use kGlobal/kCase. Kept for backwards compat with old callers. */
  k?: number;
};

async function queryByScope(
  literal: string,
  scope: "global" | "case",
  caseId: string | null,
  limit: number,
): Promise<RetrievedChunk[]> {
  if (limit <= 0) return [];
  const where =
    scope === "case" && caseId
      ? eq(schema.chunks.caseId, caseId)
      : isNull(schema.chunks.caseId);

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
    .where(where)
    .orderBy(sql`${schema.chunks.embedding} <=> ${literal}::vector`)
    .limit(limit);

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

export async function retrieve(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  // Resolve per-scope budgets. If a caller passes the legacy `k`, split
  // it 50/50 when a case is active and use it as kGlobal otherwise.
  const legacyK = opts.k;
  const caseId = opts.caseId ?? null;
  const kGlobal = opts.kGlobal ?? (legacyK !== undefined ? (caseId ? Math.ceil(legacyK / 2) : legacyK) : 6);
  const kCase = opts.kCase ?? (legacyK !== undefined ? Math.floor(legacyK / 2) : 8);

  const queryEmbedding = await embedQuery(query);
  const literal = `[${queryEmbedding.join(",")}]`;

  const [globalChunks, caseChunks] = await Promise.all([
    queryByScope(literal, "global", caseId, kGlobal),
    caseId ? queryByScope(literal, "case", caseId, kCase) : Promise.resolve([]),
  ]);

  // Interleave by similarity but always emit case chunks first when a
  // case is active — this nudges the model to anchor case-specific
  // analysis on the user's docs rather than on generic statute text.
  // The slot caps already prevent global chunks from drowning out case
  // chunks; interleaving by score within each scope keeps ordering sane.
  const all = [...caseChunks, ...globalChunks];
  return all.sort((a, b) => {
    // Stable order: case before global, then by descending similarity.
    if (a.origin !== b.origin) return a.origin === "case" ? -1 : 1;
    return b.similarity - a.similarity;
  });
}

// Format chunks for inclusion in the system prompt. Citations use the
// source field directly so the model can echo them verbatim back to the
// user instead of opaque "[Source N]" tokens. Case docs use the filename
// (e.g. claims2.txt); global docs use the formal citation (e.g.
// "35 U.S.C. § 102", "MPEP § 2131").
export function formatContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c) => {
      const label = traceableLabel(c);
      const tier = c.origin === "case" ? "CASE DOC" : authorityTier(c.docType);
      return `[${label}] (${tier})\n${c.text}`;
    })
    .join("\n\n---\n\n");
}

export function traceableLabel(c: RetrievedChunk): string {
  // Case docs: prefer the filename (already in `source` for user uploads).
  // Global docs: prefer the formal citation but strip the "(chunk N)" tail.
  if (c.origin === "case") return c.source;
  return c.citation.replace(/\s*\(chunk\s*\d+\)\s*$/i, "");
}

function authorityTier(docType: string): string {
  switch (docType) {
    case "usc":
    case "cfr":
      return "BINDING — statute/regulation";
    case "fed_circuit":
      return "BINDING — Federal Circuit";
    case "ptab_decision":
      return "PERSUASIVE — PTAB";
    case "mpep":
      return "PERSUASIVE — MPEP guidance";
    case "user_upload":
    case "office_action":
      return "CASE DOC";
    case "patent":
    case "patent_application":
      return "PRIOR ART / APPLICATION";
    default:
      return docType;
  }
}
