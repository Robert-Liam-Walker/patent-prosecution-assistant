"use client";

import { useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  draftNextMotion,
  draftNextEmail,
  draftAmendment,
  getStatus,
} from "@/app/actions/predefined";
import { toast } from "sonner";
import { FileText, Mail, Activity, FilePenLine } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Markdown } from "@/components/Markdown";

type ActionKey = "motion" | "amendment" | "email" | "status";

const ACTIONS: Array<{
  key: ActionKey;
  label: string;
  icon: React.ElementType;
  run: (caseId: string) => Promise<{ ok: boolean; output?: string; error?: string }>;
}> = [
  { key: "motion", label: "Draft next motion", icon: FileText, run: draftNextMotion },
  { key: "amendment", label: "Draft amendment + remarks", icon: FilePenLine, run: draftAmendment },
  { key: "email", label: "Draft next email", icon: Mail, run: draftNextEmail },
  { key: "status", label: "Get status", icon: Activity, run: getStatus },
];

export function ActionBar({ caseId }: { caseId: string }) {
  const [isPending, startTransition] = useTransition();
  const [activeKey, setActiveKey] = useState<ActionKey | null>(null);
  const [output, setOutput] = useState<string | null>(null);

  function run(key: ActionKey) {
    const action = ACTIONS.find((a) => a.key === key)!;
    setActiveKey(key);
    setOutput(null);
    startTransition(async () => {
      const res = await action.run(caseId);
      if (!res.ok) {
        toast.error(res.error ?? "Action failed");
        setActiveKey(null);
        return;
      }
      setOutput(res.output ?? "");
    });
  }

  const activeLabel = ACTIONS.find((a) => a.key === activeKey)?.label ?? "";

  return (
    <>
      <div className="border-b bg-muted/30 px-6 py-2 flex gap-2 flex-wrap">
        {ACTIONS.map((a) => (
          <Button
            key={a.key}
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => run(a.key)}
          >
            <a.icon className="size-3.5" />
            {a.label}
          </Button>
        ))}
        {isPending && (
          <span className="text-xs text-muted-foreground self-center ml-2">
            Running {activeLabel}…
          </span>
        )}
      </div>
      <Dialog
        open={output !== null}
        onOpenChange={(o) => {
          if (!o) {
            setOutput(null);
            setActiveKey(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{activeLabel}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <Markdown>{output ?? ""}</Markdown>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
