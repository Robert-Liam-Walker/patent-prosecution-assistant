"use server";

import { revalidatePath } from "next/cache";
import { eq, and, desc } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getCurrentUserId } from "@/lib/auth";
import { retrieve } from "@/lib/rag";
import {
  draftApplication,
  draftSection,
  renderApplicationMarkdown,
  SECTION_KEYS,
  SECTION_TITLES,
  type DraftedApplication,
  type DraftedSection,
  type SectionKey,
} from "@/lib/draft-application";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Reassemble the invention disclosure from its chunks.
 *
 * Deliberately reads from `chunks` rather than re-fetching the original file
 * from storage: the parsed text is what was actually embedded and indexed, so
 * drafting from it guarantees that anything the drafter cites is something
 * retrieval can also find. Ordering by citation keeps chunk order stable, since
 * the ingest path numbers them "(chunk N)".
 */
async function loadDisclosure(caseId: string, userId: string): Promise<string> {
  const docs = await db
    .select({ id: schema.caseDocs.id, filename: schema.caseDocs.filename, kind: schema.caseDocs.kind })
    .from(schema.caseDocs)
    .where(and(eq(schema.caseDocs.caseId, caseId), eq(schema.caseDocs.userId, userId)));

  const disclosureDocs = docs.filter((d) => d.kind === "disclosure");
  if (disclosureDocs.length === 0) {
    throw new Error(
      "No document on this case is marked as an invention disclosure. Upload one and set its type to 'Invention disclosure' — drafting cannot proceed without it, and guessing which upload is the disclosure would risk drafting from the wrong document.",
    );
  }

  const parts: string[] = [];
  for (const d of disclosureDocs) {
    const rows = await db
      .select({ text: schema.chunks.text, citation: schema.chunks.citation })
      .from(schema.chunks)
      .where(eq(schema.chunks.docId, d.id));
    const ordered = rows.sort((a, b) => {
      const n = (s: string) => Number(/chunk (\d+)/.exec(s)?.[1] ?? 0);
      return n(a.citation) - n(b.citation);
    });
    parts.push(`--- ${d.filename} ---\n${ordered.map((r) => r.text).join("\n")}`);
  }
  return parts.join("\n\n");
}

export async function generateApplicationDraft(caseId: string): Promise<Result<{ draftId: string }>> {
  try {
    const userId = await getCurrentUserId();
    const disclosure = await loadDisclosure(caseId, userId);

    // Retrieve statutory context only. The disclosure is the sole source of
    // technical facts; these chunks supply §112 / §1.72 language and drafting
    // conventions, and draft-application.ts says so explicitly in the prompt.
    const chunks = await retrieve(
      "specification requirements written description enablement claims abstract 37 CFR 1.72 35 USC 112",
      { caseId: null, kGlobal: 6 },
    );

    const app = await draftApplication(disclosure, chunks);

    const sections: Record<string, unknown> = {};
    for (const s of app.sections) sections[s.key] = { text: s.text, gapsFlagged: s.gapsFlagged, factsUsed: s.factsUsed };
    sections.claims = app.claims;
    sections._meta = { totalGaps: app.totalGaps, abstractWordCount: app.abstractWordCount };

    const title = app.sections.find((s) => s.key === "title")?.text.trim() || "Untitled application";

    const [row] = await db
      .insert(schema.drafts)
      .values({ caseId, userId, kind: "application", title, sections })
      .returning({ id: schema.drafts.id });

    revalidatePath(`/cases/${caseId}/draft`);
    return { ok: true, data: { draftId: row.id } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Regenerate one section, leaving the rest of the draft untouched. */
export async function regenerateSection(
  draftId: string,
  key: SectionKey,
): Promise<Result<{ text: string }>> {
  try {
    const userId = await getCurrentUserId();
    const [draft] = await db
      .select()
      .from(schema.drafts)
      .where(and(eq(schema.drafts.id, draftId), eq(schema.drafts.userId, userId)))
      .limit(1);
    if (!draft) throw new Error("Draft not found");

    const disclosure = await loadDisclosure(draft.caseId, userId);
    const chunks = await retrieve(
      "specification requirements written description enablement claims abstract",
      { caseId: null, kGlobal: 6 },
    );

    // Feed the sections that precede this one so regenerated text keeps the
    // terminology the rest of the specification already uses.
    const stored = draft.sections as Record<string, { text?: string }>;
    const prior: DraftedSection[] = SECTION_KEYS.slice(0, SECTION_KEYS.indexOf(key))
      .filter((k) => stored[k]?.text)
      .map((k) => ({ key: k, text: stored[k]!.text!, gapsFlagged: [], factsUsed: [] }));

    const section = await draftSection(key, disclosure, chunks, prior);

    const next = {
      ...stored,
      [key]: { text: section.text, gapsFlagged: section.gapsFlagged, factsUsed: section.factsUsed },
    };
    await db
      .update(schema.drafts)
      .set({ sections: next, updatedAt: new Date() })
      .where(eq(schema.drafts.id, draftId));

    revalidatePath(`/cases/${draft.caseId}/draft`);
    return { ok: true, data: { text: section.text } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Rebuild the DraftedApplication shape from stored jsonb, for rendering/export. */
export async function loadDraftMarkdown(draftId: string): Promise<Result<{ markdown: string; title: string }>> {
  try {
    const userId = await getCurrentUserId();
    const [draft] = await db
      .select()
      .from(schema.drafts)
      .where(and(eq(schema.drafts.id, draftId), eq(schema.drafts.userId, userId)))
      .limit(1);
    if (!draft) throw new Error("Draft not found");

    const stored = draft.sections as Record<string, never>;
    const app: DraftedApplication = {
      sections: SECTION_KEYS.filter((k) => stored[k]).map((k) => ({
        key: k,
        text: (stored[k] as { text: string }).text ?? "",
        gapsFlagged: (stored[k] as { gapsFlagged?: string[] }).gapsFlagged ?? [],
        factsUsed: (stored[k] as { factsUsed?: string[] }).factsUsed ?? [],
      })),
      claims: (stored.claims as never) ?? { claims: [], gapsFlagged: [], antecedentProblems: [] },
      totalGaps: (stored._meta as { totalGaps?: number } | undefined)?.totalGaps ?? 0,
      abstractWordCount: (stored._meta as { abstractWordCount?: number } | undefined)?.abstractWordCount ?? 0,
    };

    return { ok: true, data: { markdown: renderApplicationMarkdown(app), title: draft.title } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listDrafts(caseId: string) {
  const userId = await getCurrentUserId();
  return db
    .select({
      id: schema.drafts.id,
      title: schema.drafts.title,
      kind: schema.drafts.kind,
      updatedAt: schema.drafts.updatedAt,
    })
    .from(schema.drafts)
    .where(and(eq(schema.drafts.caseId, caseId), eq(schema.drafts.userId, userId)))
    .orderBy(desc(schema.drafts.updatedAt));
}


