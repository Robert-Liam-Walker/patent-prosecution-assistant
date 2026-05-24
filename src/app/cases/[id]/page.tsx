import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

import { db, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getCurrentUserId } from "@/lib/auth";
import { Chat } from "@/components/Chat";
import { ActionBar } from "@/components/ActionBar";
import { DocPanel } from "@/components/DocPanel";
import { FolderOpen } from "lucide-react";

export default async function CasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await getCurrentUserId();

  const [caseRow] = await db
    .select()
    .from(schema.cases)
    .where(and(eq(schema.cases.id, id), eq(schema.cases.userId, userId)))
    .limit(1);

  if (!caseRow) notFound();

  const docs = await db
    .select()
    .from(schema.caseDocs)
    .where(eq(schema.caseDocs.caseId, id));

  return (
    <div className="flex-1 flex flex-col">
      <header className="border-b px-6 py-3 flex items-center gap-3">
        <FolderOpen className="size-5" />
        <div>
          <h1 className="text-lg font-semibold">{caseRow.name}</h1>
          {caseRow.applicationNumber && (
            <p className="text-xs text-muted-foreground">
              Application #{caseRow.applicationNumber}
            </p>
          )}
        </div>
        {caseRow.nextActionDate && (
          <span className="ml-auto text-sm">
            <span className="text-muted-foreground">Next USPTO action: </span>
            <span className="font-medium">
              {caseRow.nextActionDate.toLocaleDateString()}
            </span>
          </span>
        )}
      </header>
      <ActionBar caseId={id} />
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          <Chat caseId={id} />
        </div>
        <aside className="w-80 border-l hidden lg:flex flex-col">
          <DocPanel caseId={id} docs={docs} />
        </aside>
      </div>
    </div>
  );
}
