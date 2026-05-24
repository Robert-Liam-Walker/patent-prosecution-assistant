import { streamText, convertToModelMessages, type UIMessage } from "ai";
import { chatModel } from "@/lib/llm";
import { SYSTEM_PROMPT } from "@/lib/prompts";
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
  if (lastUserText) {
    const chunks = await retrieve(lastUserText, {
      caseId: parsed.data.caseId ?? null,
      k: 8,
    });
    if (chunks.length > 0) {
      contextBlock = `\n\nRelevant sources:\n${formatContext(chunks)}`;
    }
  }

  const result = streamText({
    model: chatModel,
    system: SYSTEM_PROMPT + contextBlock,
    messages: modelMessages,
  });

  return result.toUIMessageStreamResponse();
}
