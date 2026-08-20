"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Every action's output used to render inside <pre className="whitespace-pre-wrap">,
// so `**bold**` and table syntax showed literally (README called this out as a
// known limitation). That was survivable for a five-line status card. It is not
// survivable for a patent application draft, where the claim listing, the
// <u>/<s> amendment markup, and the ⚠️ warnings all depend on real rendering.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:whitespace-pre-wrap prose-headings:font-semibold">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Amendment markup: 37 C.F.R. § 1.121 requires deletions struck
          // through and insertions underlined. These are the only two raw HTML
          // tags the drafters emit, and they carry legal meaning -- an amended
          // claim without visible markup cannot be filed.
          u: ({ children }) => <u className="underline decoration-2">{children}</u>,
          s: ({ children }) => <s className="line-through opacity-70">{children}</s>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-amber-500/60 bg-amber-500/5 pl-4 py-1 not-italic">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
