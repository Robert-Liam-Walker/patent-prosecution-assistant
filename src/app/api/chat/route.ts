import { streamText, convertToModelMessages, type UIMessage } from "ai";
import { chatModel } from "@/lib/llm";
import { SYSTEM_PROMPT, NO_SOURCES_NOTE } from "@/lib/prompts";
import { retrieve, formatContext } from "@/lib/rag";
import {
  analyzeRejection,
  isRejectionAnalysisQuery,
  renderAnalysisMarkdown,
} from "@/lib/analyze-rejection";
import { z } from "zod";

const bodySchema = z.object({
  messages: z.array(z.unknown()),
  caseId: z.string().uuid().optional().nullable(),
});

export async function POST(req: Request) {
  const json = await req.json();
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid body" }), {
      status: 400,
    });
  }
  const uiMessages = parsed.data.messages as UIMessage[];
  const modelMessages = await convertToModelMessages(uiMessages);

  // RAG over last user message.
  const lastUserUi = [...uiMessages].reverse().find((m) => m.role === "user");
  const lastUserText =
    lastUserUi?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ") ?? "";

  let contextBlock = "";
  let sourcesFound = false;
  let retrievedChunks: Awaited<ReturnType<typeof retrieve>> = [];
  if (lastUserText) {
    retrievedChunks = await retrieve(lastUserText, {
      caseId: parsed.data.caseId ?? null,
      // Per-scope budgets: case docs need their own slots, otherwise generic
      // statute/MPEP chunks dominate the top-k for case-specific queries.
      kCase: 8,
      kGlobal: 6,
    });
    if (retrievedChunks.length > 0) {
      sourcesFound = true;
      contextBlock = `\n\nRetrieved sources:\n${formatContext(retrievedChunks)}`;
    }
  }

  // Route §102/§103 rejection-analysis queries through the structured
  // analyzer (generateObject + Zod). Narrative prompts on Llama 3.1 8B
  // kept emitting banned terminology and skipping the (A)–(E) template
  // (see backlog 4a/4b/4c). Schema enums + slot-filling make label drift
  // structurally impossible. Falls back to freeform streamText if the
  // structured pass throws (e.g. JSON parse failure on small models).
  if (
    sourcesFound &&
    lastUserText &&
    isRejectionAnalysisQuery(lastUserText, retrievedChunks)
  ) {
    try {
      const analysis = await analyzeRejection(lastUserText, retrievedChunks);
      const markdown = renderAnalysisMarkdown(analysis);
      const stream = streamText({
        model: chatModel,
        messages: [
          { role: "user", content: `Repeat the following markdown verbatim, exactly as given. Do not add commentary, headers, or any other text.\n\n${markdown}` },
        ],
      });
      return stream.toUIMessageStreamResponse();
    } catch (err) {
      console.error("[chat] analyzeRejection failed, falling back to freeform", err);
      // fall through to streamText below
    }
  }

  // Force FRAMEWORK mode when retrieval is empty — prevents the model from
  // fabricating element-by-element mappings against imagined prior art.
  const systemPrompt = sourcesFound
    ? SYSTEM_PROMPT + contextBlock
    : SYSTEM_PROMPT + NO_SOURCES_NOTE;

  const result = streamText({
    model: chatModel,
    system: systemPrompt,
    messages: modelMessages,
  });

  return result.toUIMessageStreamResponse();
}
