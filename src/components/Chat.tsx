"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, User, Sparkles } from "lucide-react";
import { Markdown } from "@/components/Markdown";

export function Chat({ caseId }: { caseId?: string }) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: { caseId },
      }),
    [caseId],
  );

  const { messages, sendMessage, status } = useChat({ transport });

  const [input, setInput] = useState("");
  const isStreaming = status === "submitted" || status === "streaming";

  function submit() {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    sendMessage({ text: trimmed });
    setInput("");
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ScrollArea className="flex-1 px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground py-12 text-sm">
              {caseId
                ? "Ask anything about this case. Uploaded docs + global corpus will be searched."
                : "Ask a research question. Global corpus only (open a case to include uploaded docs)."}
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {isStreaming && (
            <div className="text-xs text-muted-foreground">…thinking</div>
          )}
        </div>
      </ScrollArea>
      <div className="border-t bg-background p-4">
        <div className="max-w-3xl mx-auto flex gap-2 items-end">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              caseId
                ? "Ask about this case…"
                : "Search MPEP, USC, caselaw…"
            }
            className="resize-none min-h-[60px] max-h-[200px]"
            disabled={isStreaming}
          />
          <Button onClick={submit} disabled={isStreaming || !input.trim()} size="icon" className="size-11">
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: { id: string; role: string; parts?: Array<{ type: string; text?: string }> } }) {
  const text =
    message.parts
      ?.filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("") ?? "";

  if (message.role === "user") {
    return (
      <div className="flex gap-3">
        <div className="size-7 rounded-full bg-primary/10 grid place-items-center shrink-0">
          <User className="size-3.5" />
        </div>
        <div className="flex-1 whitespace-pre-wrap text-sm pt-1">{text}</div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <div className="size-7 rounded-full bg-foreground text-background grid place-items-center shrink-0">
        <Sparkles className="size-3.5" />
      </div>
      {/* Assistant output is markdown -- the rejection analyzer streams a
          rendered (A)-(E) template with headers, quotes and warnings. */}
      <div className="flex-1 text-sm pt-1 leading-relaxed">
        <Markdown>{text}</Markdown>
      </div>
    </div>
  );
}
