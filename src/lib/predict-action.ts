// Structured "predict next USPTO action" analyzer.
//
// Follows the analyze-rejection.ts pattern: flat schema, generateObject
// with Ollama format:json, retry on validation failure, derive verdict
// fields from atomic labels, render markdown from our code so headers
// are guaranteed.
//
// Why structured here: freeform predictions on Llama 3.1 8B drift into
// hedge ("could be X or Y depending on…") instead of committing.
// Enum + probability band + reasoning slots force a commitment that
// the prosecutor can evaluate at a glance.

import { generateObject } from "ai";
import { z } from "zod";
import { chatModel } from "@/lib/llm";
import { traceableLabel, type RetrievedChunk } from "@/lib/rag";

const ActionType = z.enum([
  "NON_FINAL_OA",
  "FINAL_OA",
  "NOTICE_OF_ALLOWANCE",
  "NOTICE_OF_ABANDONMENT",
  "ADVISORY_ACTION",
  "EXAMINER_INTERVIEW",
  "EXAMINER_AMENDMENT",
  "REQUIREMENT_FOR_INFORMATION",
  "RESTRICTION_REQUIREMENT",
  "QUAYLE_ACTION",
  "OTHER",
]);

const Probability = z.enum(["LOW", "MEDIUM", "HIGH"]);

// Coerce unrecognized strings to OTHER / MEDIUM so a missing schema
// match doesn't tank the whole call.
const SoftActionType = z
  .union([ActionType, z.string()])
  .transform((v) => (ActionType.safeParse(v).success ? (v as z.infer<typeof ActionType>) : "OTHER"));

const SoftProbability = z
  .union([Probability, z.string()])
  .transform((v) => {
    const up = String(v).toUpperCase();
    if (Probability.safeParse(up).success) return up as z.infer<typeof Probability>;
    return "MEDIUM";
  });

const Alternative = z.object({
  action: SoftActionType,
  probability: SoftProbability,
  reason: z.string().describe("One sentence anchored to a case fact or authority."),
});

const ModelOutputSchema = z.object({
  mostLikelyAction: SoftActionType,
  probability: SoftProbability,
  reasoning: z.string().describe("2-4 sentences citing case facts, MPEP §§, statutes; anchor every claim to a [label] from the retrieval block."),
  alternatives: z.array(Alternative).nullish().transform((v) => v ?? []).describe("Up to 2 alternative scenarios with their own probability + anchor. Empty if the prediction is unambiguous."),
  recommendedPreparation: z.array(z.string()).nullish().transform((v) => v ?? []).describe("Bullet list of concrete preparation actions for the prosecutor."),
  examinerStatsUsed: z.boolean().nullish().transform((v) => Boolean(v)).describe("True iff examiner-specific statistics were available in the retrieved context."),
});

export const PredictedActionSchema = ModelOutputSchema.extend({
  // Render-only fields (none derived for this analyzer — model output is
  // already in the right shape).
});

export type PredictedAction = z.infer<typeof PredictedActionSchema>;

const PREDICT_SYSTEM = `You are a USPTO patent practitioner. Predict the next likely USPTO action for an application based on the case summary + retrieved sources. Output ONLY a JSON object matching the schema. No prose before or after.

Hard rules:
- Commit to a single mostLikelyAction. Do not hedge in this field.
- probability is LOW / MEDIUM / HIGH only — not a number, not a range.
- reasoning MUST cite specific facts from the case summary or [label]s from the retrieval block. Generic prosecution wisdom is NOT acceptable reasoning — anchor every sentence.
- Do NOT guess timelines, examiner names, or filing dates unless they appear verbatim in context.
- alternatives is OPTIONAL and capped at 2. Skip if the prediction is unambiguous.
- recommendedPreparation is a bullet list of concrete, actionable items (e.g. "Draft RCE with amendments to claims 1, 3, 7"), not generic advice.
- examinerStatsUsed: true ONLY if the retrieved sources include examiner statistics. Default false.

Action type enum (use exactly one):
  NON_FINAL_OA, FINAL_OA, NOTICE_OF_ALLOWANCE, NOTICE_OF_ABANDONMENT,
  ADVISORY_ACTION, EXAMINER_INTERVIEW, EXAMINER_AMENDMENT,
  REQUIREMENT_FOR_INFORMATION, RESTRICTION_REQUIREMENT, QUAYLE_ACTION, OTHER

Example shape:
{
  "mostLikelyAction": "FINAL_OA",
  "probability": "HIGH",
  "reasoning": "First office action under §103 over Smith and Jones was non-final ([office_action.txt]). Applicant's last response argued non-obviousness without amendment ([applicant_response.txt]). Examiner is statistically unlikely to withdraw §103 without amendment.",
  "alternatives": [
    { "action": "ADVISORY_ACTION", "probability": "MEDIUM", "reason": "If applicant filed AFCP 2.0 request with the response, examiner may issue advisory action first." }
  ],
  "recommendedPreparation": [
    "Prepare RCE with substantive amendment to claim 1 narrowing the 'similarity' limitation",
    "Draft examiner-interview request to discuss §103 obviousness rationale"
  ],
  "examinerStatsUsed": false
}`;

export async function predictNextAction(
  caseSummary: string,
  chunks: RetrievedChunk[],
  opts: { maxAttempts?: number } = {},
): Promise<PredictedAction> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const sourcesBlock = chunks
    .map((c) => `[${traceableLabel(c)}] (${c.origin})\n${c.text}`)
    .join("\n\n---\n\n");

  const prompt = `Case summary:
${caseSummary}

Retrieved sources:
${sourcesBlock || "(none)"}

Predict the next USPTO action. Anchor every reasoning sentence to a specific case fact or [label]. Output the JSON object now.`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { object } = await generateObject({
        model: chatModel,
        schema: ModelOutputSchema,
        system: PREDICT_SYSTEM,
        prompt,
        temperature: 0.1,
        providerOptions: { ollama: { format: "json" } },
      });
      return object;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) console.warn(`[predict-action] attempt ${attempt} failed, retrying...`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`predictNextAction failed after ${maxAttempts} attempts`);
}

export function renderPredictedActionMarkdown(p: PredictedAction): string {
  const lines: string[] = [];
  lines.push(`**Most likely next action:** **${p.mostLikelyAction}** (probability: **${p.probability}**)`);
  lines.push("");
  lines.push("**Reasoning**");
  lines.push("");
  lines.push(p.reasoning);
  lines.push("");
  if (p.alternatives.length > 0) {
    lines.push("**Alternative scenarios**");
    lines.push("");
    for (const alt of p.alternatives.slice(0, 2)) {
      lines.push(`- **${alt.action}** (${alt.probability}): ${alt.reason}`);
    }
    lines.push("");
  }
  if (p.recommendedPreparation.length > 0) {
    lines.push("**Recommended preparation**");
    lines.push("");
    for (const rec of p.recommendedPreparation) {
      lines.push(`- ${rec}`);
    }
    lines.push("");
  }
  if (!p.examinerStatsUsed) {
    lines.push("_Note: no examiner-specific statistics in retrieved context. Predictions are based on case facts and prosecution norms only._");
  }
  return lines.join("\n");
}
