"use client";

import { useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Upload } from "lucide-react";
import { createCase } from "@/app/actions/cases";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

export function AddCaseButton() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button size="icon-xs" variant="ghost" />}
      >
        <Plus className="size-4" />
        <span className="sr-only">Add case</span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a new case</DialogTitle>
          <DialogDescription>
            Set up a case workspace. You can upload documents now or later.
          </DialogDescription>
        </DialogHeader>
        <AddCaseForm onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function AddCaseForm({ onDone }: { onDone: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  async function action(formData: FormData) {
    startTransition(async () => {
      try {
        const result = await createCase(formData);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        const caseId = result.caseId;

        // Upload files via /api/docs after the case exists.
        if (files.length > 0) {
          const upload = new FormData();
          upload.append("caseId", caseId);
          for (const f of files) upload.append("files", f);
          const res = await fetch("/api/docs", {
            method: "POST",
            body: upload,
          });
          if (!res.ok) {
            toast.warning(
              `Case created but document upload failed (${res.status}). You can retry from the case page.`,
            );
          }
        }
        toast.success("Case created");
        onDone();
        router.push(`/cases/${caseId}`);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to create case");
      }
    });
  }

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Case name *</Label>
        <Input id="name" name="name" required placeholder="ACME — touchscreen widget" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="applicationNumber">Application number</Label>
        <Input
          id="applicationNumber"
          name="applicationNumber"
          placeholder="17/123,456"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="dateStarted">Date started</Label>
          <Input id="dateStarted" name="dateStarted" type="date" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="nextActionDate">Next USPTO action</Label>
          <Input
            id="nextActionDate"
            name="nextActionDate"
            type="date"
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="files">Upload documents</Label>
        <div className="relative border border-dashed rounded-md px-3 py-6 text-center text-sm text-muted-foreground hover:bg-accent transition">
          <Upload className="size-5 mx-auto mb-2" />
          <p>
            {files.length > 0
              ? `${files.length} file${files.length === 1 ? "" : "s"} selected`
              : "PDF, Word, .txt — drop or click to choose"}
          </p>
          <input
            id="files"
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
        </div>
      </div>
      <DialogFooter>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Creating…" : "Create case"}
        </Button>
      </DialogFooter>
    </form>
  );
}
