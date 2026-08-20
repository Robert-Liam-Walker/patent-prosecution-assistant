"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText, Upload } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

export function DocPanel({
  caseId,
  docs,
}: {
  caseId: string;
  docs: Array<{
    id: string;
    filename: string;
    mime: string;
    chunkCount: number;
    uploadedAt: Date;
  }>;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  // Document kind is chosen at upload, not inferred. Drafting refuses to run
  // without a document explicitly marked as the invention disclosure --
  // guessing which upload is the disclosure risks drafting a specification for
  // the wrong invention.
  const [kind, setKind] = useState<string>("other");

  function onUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    startTransition(async () => {
      const form = new FormData();
      form.append("caseId", caseId);
      form.append("kind", kind);
      for (const f of Array.from(files)) form.append("files", f);
      const res = await fetch("/api/docs", { method: "POST", body: form });
      if (!res.ok) {
        toast.error(`Upload failed: ${res.status}`);
        return;
      }
      toast.success("Uploaded — chunks embedded");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b">
        <h2 className="text-sm font-semibold">Case documents</h2>
        <p className="text-xs text-muted-foreground">
          {docs.length} {docs.length === 1 ? "file" : "files"} ·{" "}
          {docs.reduce((s, d) => s + d.chunkCount, 0)} chunks
        </p>
      </div>
      <ScrollArea className="flex-1">
        <ul className="divide-y">
          {docs.map((d) => (
            <li key={d.id} className="px-4 py-2 flex items-start gap-2">
              <FileText className="size-4 mt-0.5 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <p className="text-sm truncate">{d.filename}</p>
                <p className="text-xs text-muted-foreground">
                  {d.chunkCount} chunks · {new Date(d.uploadedAt).toLocaleDateString()}
                </p>
              </div>
            </li>
          ))}
          {docs.length === 0 && (
            <p className="px-4 py-6 text-xs text-muted-foreground text-center">
              No documents uploaded yet.
            </p>
          )}
        </ul>
      </ScrollArea>
      <div className="border-t p-3">
        <label
          className={
            "flex items-center justify-center gap-1.5 w-full border rounded-md py-2 text-sm cursor-pointer hover:bg-accent transition " +
            (isPending ? "opacity-50 pointer-events-none" : "")
          }
        >
          <Upload className="size-3.5" />
          {isPending ? "Uploading…" : "Add documents"}
          <input
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md"
            className="hidden"
            onChange={(e) => onUpload(e.target.files)}
          />
        </label>
      </div>
    </div>
  );
}
