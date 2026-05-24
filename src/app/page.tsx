import { Chat } from "@/components/Chat";
import { ScrollText } from "lucide-react";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <div className="flex-1 flex flex-col">
      <header className="border-b px-6 py-3 flex items-center gap-3">
        <ScrollText className="size-5" />
        <h1 className="text-lg font-semibold">Patent Prosecution Assistant</h1>
        <span className="text-sm text-muted-foreground ml-2">
          Global research (no active case)
        </span>
      </header>
      <Chat />
    </div>
  );
}
