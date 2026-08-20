import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getCurrentUserId } from "@/lib/auth";
import { DraftWorkspace } from "@/components/DraftWorkspace";

export const dynamic = "force-dynamic";

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await getCurrentUserId();

  const [c] = await db
    .select()
    .from(schema.cases)
    .where(and(eq(schema.cases.id, id), eq(schema.cases.userId, userId)))
    .limit(1);
  if (!c) notFound();

  const docs = await db
    .select({ id: schema.caseDocs.id, filename: schema.caseDocs.filename, kind: schema.caseDocs.kind })
    .from(schema.caseDocs)
    .where(eq(schema.caseDocs.caseId, id));

  const drafts = await db
    .select({
      id: schema.drafts.id,
      title: schema.drafts.title,
      kind: schema.drafts.kind,
      updatedAt: schema.drafts.updatedAt,
    })
    .from(schema.drafts)
    .where(and(eq(schema.drafts.caseId, id), eq(schema.drafts.userId, userId)));

  const hasDisclosure = docs.some((d) => d.kind === "disclosure");

  return (
    <div className="flex flex-col h-dvh">
      <header className="border-b px-6 py-3">
        <div className="flex items-baseline gap-3">
          <Link href={`/cases/${id}`} className="text-sm text-muted-foreground hover:underline">
            ← {c.name}
          </Link>
          <h1 className="text-lg font-semibold">Draft application</h1>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Generated from the invention disclosure on this case. Every technical fact must trace to that
          disclosure; anything it does not cover is flagged for attorney input rather than invented.
        </p>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <DraftWorkspace
          caseId={id}
          hasDisclosure={hasDisclosure}
          drafts={drafts.map((d) => ({ ...d, updatedAt: d.updatedAt.toISOString() }))}
          docs={docs}
        />
      </div>
    </div>
  );
}
