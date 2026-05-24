import { streamText, convertToModelMessages, type UIMessage } from "ai";
import { chatModel } from "@/lib/llm";
import { SYSTEM_PROMPT, NO_SOURCES_NOTE } from "@/lib/prompts";
import { retrieve, formatContext } from "@/lib/rag";
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
  if (lastUserText) {
    const chunks = await retrieve(lastUserText, {
      caseId: parsed.data.caseId ?? null,
      k: 8,
    });
    if (chunks.length > 0) {
      sourcesFound = true;
      contextBlock = `\n\nRetrieved sources:\n${formatContext(chunks)}`;
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
