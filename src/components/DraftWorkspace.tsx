"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/Markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText, RefreshCw, Download, AlertTriangle } from "lucide-react";
import {
  generateApplicationDraft,
  loadDraftMarkdown,
  regenerateSection,
} from "@/app/actions/drafting";
import { SECTION_KEYS, SECTION_TITLES, type SectionKey } from "@/lib/draft-sections";

type DraftRow = { id: string; title: string; kind: string; updatedAt: string };
type DocRow = { id: string; filename: string; kind: string };

export function DraftWorkspace({
  caseId,
  hasDisclosure,
  drafts,
  docs,
}: {
  caseId: string;
  hasDisclosure: boolean;
  drafts: DraftRow[];
  docs: DocRow[];
}) {
  const [pending, start] = useTransition();
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [busySection, setBusySection] = useState<SectionKey | null>(null);

  function open(draftId: string) {
    start(async () => {
      const r = await loadDraftMarkdown(draftId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setMarkdown(r.data.markdown);
      setActiveDraftId(draftId);
    });
  }

  function generate() {
    start(async () => {
      toast.info("Drafting — this runs eight reasoning passes and takes a few minutes.");
      const r = await generateApplicationDraft(caseId);
      if (!r.ok) {
        toast.error(r.error, { duration: 12000 });
        return;
      }
      toast.success("Draft generated");
      open(r.data.draftId);
    });
  }

  function regenerate(key: SectionKey) {
    if (!activeDraftId) return;
    setBusySection(key);
    start(async () => {
      const r = await regenerateSection(activeDraftId, key);
      setBusySection(null);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`${SECTION_TITLES[key]} regenerated`);
      open(activeDraftId);
    });
  }

  if (!hasDisclosure) {
    return (
      <div className="max-w-2xl space-y-4">
        <div className="flex gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
          <AlertTriangle className="size-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm space-y-2">
            <p className="font-medium">No invention disclosure on this case.</p>
            <p className="text-muted-foreground">
              Drafting needs a document explicitly marked as the invention disclosure. It is not inferred
              from the upload list — drafting a specification from the wrong document (an office action, a
              prior-art reference) would produce a plausible application for the wrong invention.
            </p>
            {docs.length > 0 && (
              <p className="text-muted-foreground">
                Uploaded on this case: {docs.map((d) => `${d.filename} (${d.kind})`).join(", ")}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[240px_1fr] gap-6 h-full">
      <aside className="space-y-3">
        <Button onClick={generate} disabled={pending} className="w-full">
          <FileText className="size-4" />
          {pending && !busySection ? "Drafting…" : "Generate draft"}
        </Button>

        {drafts.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground px-1">Existing drafts</p>
            {drafts.map((d) => (
              <button
                key={d.id}
                onClick={() => open(d.id)}
                className={`w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent ${
                  activeDraftId === d.id ? "bg-accent" : ""
                }`}
              >
                <span className="block truncate">{d.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {new Date(d.updatedAt).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        )}

        {activeDraftId && (
          <>
            <a href={`/api/drafts/${activeDraftId}/docx`} className="block">
              <Button variant="outline" className="w-full">
                <Download className="size-4" />
                Export .docx
              </Button>
            </a>
            <div className="space-y-1 pt-2">
              <p className="text-xs font-medium text-muted-foreground px-1">Regenerate section</p>
              {SECTION_KEYS.map((k) => (
                <Button
                  key={k}
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-xs"
                  disabled={pending}
                  onClick={() => regenerate(k)}
                >
                  <RefreshCw className={`size-3 ${busySection === k ? "animate-spin" : ""}`} />
                  {SECTION_TITLES[k]}
                </Button>
              ))}
            </div>
          </>
        )}
      </aside>

      <ScrollArea className="h-full rounded-md border p-6">
        {markdown ? (
          <Markdown>{markdown}</Markdown>
        ) : (
          <p className="text-sm text-muted-foreground">
            Generate a draft, or open an existing one.
          </p>
        )}
      </ScrollArea>
    </div>
  );
}
