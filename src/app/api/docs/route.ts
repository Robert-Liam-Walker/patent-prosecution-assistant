import { NextRequest } from "next/server";
import { db, schema } from "@/lib/db";
import { getCurrentUserId } from "@/lib/auth";
import { putObject } from "@/lib/storage";
import { extractText } from "@/lib/parse";
import { chunkText } from "@/lib/chunk";
import { embedBatch } from "@/lib/embed";
import { eq, and } from "drizzle-orm";

export async function POST(req: NextRequest) {
  try {
    const userId = await getCurrentUserId();
    const form = await req.formData();
    const caseId = form.get("caseId");
    if (typeof caseId !== "string") {
      return Response.json({ error: "caseId required" }, { status: 400 });
    }

    const [caseRow] = await db
      .select({ id: schema.cases.id })
      .from(schema.cases)
      .where(and(eq(schema.cases.id, caseId), eq(schema.cases.userId, userId)))
      .limit(1);
    if (!caseRow) {
      return Response.json({ error: "Case not found" }, { status: 404 });
    }

    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return Response.json({ error: "no files" }, { status: 400 });
    }

    const results: Array<{ filename: string; chunks: number }> = [];
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const storageKey = `${userId}/${caseId}/${Date.now()}-${file.name}`;
      await putObject(storageKey, buffer, file.type || "application/octet-stream");

      let text: string;
      try {
        text = await extractText(buffer, file.type, file.name);
      } catch (e) {
        results.push({ filename: file.name, chunks: 0 });
        // Still keep the file row even if extraction fails, so the user sees it.
        await db.insert(schema.caseDocs).values({
          caseId,
          userId,
          filename: file.name,
          mime: file.type || "application/octet-stream",
          storageKey,
          sizeBytes: buffer.length,
          chunkCount: 0,
        });
        continue;
      }

      const chunks = chunkText(text, file.name);
      const embeddings =
        chunks.length > 0 ? await embedBatch(chunks.map((c) => c.text)) : [];

      const [docRow] = await db
        .insert(schema.caseDocs)
        .values({
          caseId,
          userId,
          filename: file.name,
          mime: file.type || "application/octet-stream",
          storageKey,
          sizeBytes: buffer.length,
          chunkCount: chunks.length,
        })
        .returning({ id: schema.caseDocs.id });

      if (chunks.length > 0) {
        await db.insert(schema.chunks).values(
          chunks.map((c, i) => ({
            caseId,
            userId,
            docId: docRow.id,
            docType: "user_upload" as const,
            source: file.name,
            sourceUrl: null,
            citation: `${file.name} (chunk ${i + 1})`,
            text: c.text,
            embedding: embeddings[i],
          })),
        );
      }
      results.push({ filename: file.name, chunks: chunks.length });
    }

    return Response.json({ ok: true, results });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

// Allow larger payloads for PDFs/Word docs.
export const runtime = "nodejs";
export const maxDuration = 60;
