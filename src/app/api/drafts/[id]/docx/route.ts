import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getCurrentUserId } from "@/lib/auth";
import { applicationToDocx } from "@/lib/export-docx";
import { SECTION_KEYS, type DraftedApplication } from "@/lib/draft-application";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const userId = await getCurrentUserId();

  const [draft] = await db
    .select()
    .from(schema.drafts)
    .where(and(eq(schema.drafts.id, id), eq(schema.drafts.userId, userId)))
    .limit(1);
  if (!draft) return new Response("Not found", { status: 404 });

  const [c] = await db.select().from(schema.cases).where(eq(schema.cases.id, draft.caseId)).limit(1);

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

  const buf = await applicationToDocx(app, c?.name ?? "case");
  const safe = draft.title.replace(/[^\w\s-]/g, "").trim().slice(0, 60).replace(/\s+/g, "_") || "draft";

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${safe}.docx"`,
    },
  });
}
