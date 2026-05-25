"use server";

import { generateText } from "ai";
import { chatModel } from "@/lib/llm";
import { db, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getCurrentUserId } from "@/lib/auth";
import { DRAFT_EMAIL_PROMPT, SYSTEM_PROMPT, NO_SOURCES_NOTE } from "@/lib/prompts";
import { retrieve, formatContext, type RetrievedChunk } from "@/lib/rag";
import { getApplicationStatus } from "@/lib/uspto";
import { draftNextMotion as draftNextMotionStructured, renderDraftedMotionMarkdown } from "@/lib/draft-motion";
import { predictNextAction as predictNextActionStructured, renderPredictedActionMarkdown } from "@/lib/predict-action";
import { getCaseStatus as getCaseStatusStructured, renderCaseStatusMarkdown } from "@/lib/case-status";

type ActionResult = { ok: true; output: string } | { ok: false; error: string };

async function loadCaseSummary(caseId: string): Promise<string> {
  const userId = await getCurrentUserId();
  const [c] = await db
    .select()
    .from(schema.cases)
    .where(and(eq(schema.cases.id, caseId), eq(schema.cases.userId, userId)))
    .limit(1);
  if (!c) throw new Error("Case not found");

  const docs = await db
    .select({ filename: schema.caseDocs.filename, chunkCount: schema.caseDocs.chunkCount })
    .from(schema.caseDocs)
    .where(eq(schema.caseDocs.caseId, caseId));

  return [
    `Case: ${c.name}`,
    c.applicationNumber ? `Application #: ${c.applicationNumber}` : null,
    c.dateStarted ? `Started: ${c.dateStarted.toLocaleDateString()}` : null,
    c.nextActionDate ? `Next USPTO action due: ${c.nextActionDate.toLocaleDateString()}` : null,
    `Uploaded docs (${docs.length}): ${docs.map((d) => d.filename).join(", ") || "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function withRetrievedContext(
  caseId: string,
  query: string,
): Promise<{ ctx: string; chunks: RetrievedChunk[] }> {
  const chunks = await retrieve(query, { caseId, kCase: 8, kGlobal: 6 });
  return { ctx: formatContext(chunks), chunks };
}

function systemFor(chunks: RetrievedChunk[]): string {
  return chunks.length > 0 ? SYSTEM_PROMPT : SYSTEM_PROMPT + NO_SOURCES_NOTE;
}

export async function draftNextMotion(caseId: string): Promise<ActionResult> {
  try {
    const summary = await loadCaseSummary(caseId);
    const { chunks } = await withRetrievedContext(
      caseId,
      "outstanding rejections; next required filing; office action response",
    );
    const result = await draftNextMotionStructured(summary, chunks);
    return { ok: true, output: renderDraftedMotionMarkdown(result) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Email drafting hasn't been migrated to structured output — it stays
// on freeform generateText because the schema would be minimal
// (recipient/subject/body) and the freeform prompt already works well
// enough. Revisit if hallucination becomes an issue.
export async function draftNextEmail(caseId: string): Promise<ActionResult> {
  try {
    const summary = await loadCaseSummary(caseId);
    const { ctx, chunks } = await withRetrievedContext(
      caseId,
      "recent correspondence; client updates",
    );
    const { text } = await generateText({
      model: chatModel,
      system: systemFor(chunks),
      prompt: `${DRAFT_EMAIL_PROMPT(summary)}\n\nSources:\n${ctx || "(none retrieved)"}`,
    });
    return { ok: true, output: text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function predictNextAction(caseId: string): Promise<ActionResult> {
  try {
    const summary = await loadCaseSummary(caseId);
    const { chunks } = await withRetrievedContext(
      caseId,
      "office action history; rejections; examiner patterns; finality",
    );
    const result = await predictNextActionStructured(summary, chunks);
    return { ok: true, output: renderPredictedActionMarkdown(result) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function getStatus(caseId: string): Promise<ActionResult> {
  try {
    const userId = await getCurrentUserId();
    const [c] = await db
      .select()
      .from(schema.cases)
      .where(and(eq(schema.cases.id, caseId), eq(schema.cases.userId, userId)))
      .limit(1);
    if (!c) throw new Error("Case not found");

    let usptoText = "(no application number on file)";
    if (c.applicationNumber) {
      try {
        const status = await getApplicationStatus(c.applicationNumber);
        usptoText = JSON.stringify(status, null, 2);
      } catch (e) {
        usptoText = `(USPTO ODP lookup failed: ${e instanceof Error ? e.message : String(e)})`;
      }
    }

    const summary = await loadCaseSummary(caseId);
    const result = await getCaseStatusStructured(usptoText, summary);
    return { ok: true, output: renderCaseStatusMarkdown(result) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
