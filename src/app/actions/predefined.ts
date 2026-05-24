"use server";

import { generateText } from "ai";
import { chatModel } from "@/lib/llm";
import { db, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getCurrentUserId } from "@/lib/auth";
import {
  DRAFT_MOTION_PROMPT,
  DRAFT_EMAIL_PROMPT,
  PREDICT_NEXT_ACTION_PROMPT,
  SUMMARIZE_STATUS_PROMPT,
  SYSTEM_PROMPT,
} from "@/lib/prompts";
import { retrieve, formatContext } from "@/lib/rag";
import { getApplicationStatus } from "@/lib/uspto";

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
): Promise<string> {
  const chunks = await retrieve(query, { caseId, k: 10 });
  return formatContext(chunks);
}

export async function draftNextMotion(caseId: string): Promise<ActionResult> {
  try {
    const summary = await loadCaseSummary(caseId);
    const ctx = await withRetrievedContext(
      caseId,
      "outstanding rejections; next required filing under MPEP",
    );
    const { text } = await generateText({
      model: chatModel,
      system: SYSTEM_PROMPT,
      prompt: `${DRAFT_MOTION_PROMPT(summary)}\n\nSources:\n${ctx}`,
    });
    return { ok: true, output: text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function draftNextEmail(caseId: string): Promise<ActionResult> {
  try {
    const summary = await loadCaseSummary(caseId);
    const ctx = await withRetrievedContext(caseId, "recent correspondence; client updates");
    const { text } = await generateText({
      model: chatModel,
      system: SYSTEM_PROMPT,
      prompt: `${DRAFT_EMAIL_PROMPT(summary)}\n\nSources:\n${ctx}`,
    });
    return { ok: true, output: text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function predictNextAction(caseId: string): Promise<ActionResult> {
  try {
    const summary = await loadCaseSummary(caseId);
    const ctx = await withRetrievedContext(
      caseId,
      "office action history; rejections; examiner patterns",
    );
    const { text } = await generateText({
      model: chatModel,
      system: SYSTEM_PROMPT,
      prompt: `${PREDICT_NEXT_ACTION_PROMPT(summary)}\n\nSources:\n${ctx}`,
    });
    return { ok: true, output: text };
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
    const { text } = await generateText({
      model: chatModel,
      system: SYSTEM_PROMPT,
      prompt: SUMMARIZE_STATUS_PROMPT(usptoText, summary),
    });
    return { ok: true, output: text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
