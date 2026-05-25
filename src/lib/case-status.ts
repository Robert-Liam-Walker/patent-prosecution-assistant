// Structured "get case status" analyzer.
//
// Synthesizes a status card from USPTO ODP data (when available) and
// uploaded case docs. Every field is nullable — the schema enforces
// "(not in record)" semantics so the model can't fabricate missing
// values. The renderer prints "(not in record)" for nulls.

import { generateObject } from "ai";
import { z } from "zod";
import { chatModel } from "@/lib/llm";

const Deadline = z.object({
  description: z.string().describe("Short label, e.g. 'Response to non-final OA'."),
  date: z.string().nullish().transform((v) => v ?? "").describe("ISO or human-readable date as it appears in the source. Empty if no specific date in record."),
});

const OpenIssue = z.object({
  issueType: z.string().describe("Short label, e.g. '§102 rejection' or '§112(b) indefiniteness'."),
  affectedClaims: z.array(z.string()).nullish().transform((v) => v ?? []).describe("Claim numbers affected, e.g. ['1', '3-7']."),
});

const ModelOutputSchema = z.object({
  applicationNumber: z.string().nullish().transform((v) => v ?? "").describe("Verbatim from ODP/case-doc context, or empty if not in record."),
  filingDate: z.string().nullish().transform((v) => v ?? "").describe("From ODP, or empty."),
  status: z.string().nullish().transform((v) => v ?? "").describe("From ODP (e.g. 'Awaiting Examiner Action'), or empty."),
  latestActionType: z.string().nullish().transform((v) => v ?? "").describe("From ODP transaction history or latest OA in case docs."),
  latestActionDate: z.string().nullish().transform((v) => v ?? "").describe("Date of latest action; empty if not in record."),
  examinerName: z.string().nullish().transform((v) => v ?? "").describe("From ODP metadata, or empty."),
  artUnit: z.string().nullish().transform((v) => v ?? "").describe("From ODP metadata, or empty."),
  outstandingDeadlines: z.array(Deadline).nullish().transform((v) => v ?? []).describe("Concrete deadlines with specific dates from the record. Empty if none in record."),
  openIssues: z.array(OpenIssue).nullish().transform((v) => v ?? []).describe("Outstanding rejections / objections with affected claims, only from the record."),
  recommendedNextStep: z.string().nullish().transform((v) => v ?? "").describe("One sentence. Concrete next action for the prosecutor (e.g. 'file response to non-final OA addressing §103 over Smith by 2026-08-15'). Empty if insufficient data; the renderer will surface that."),
});

export const CaseStatusSchema = ModelOutputSchema;
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

const STATUS_SYSTEM = `You are a USPTO patent practitioner producing a status card for a busy attorney. Output ONLY a JSON object matching the schema. No prose before or after.

Hard rules:
- Every field except recommendedNextStep is OPTIONAL — use empty string / empty array if the value is not in the provided ODP data or uploaded docs. NEVER invent application numbers, dates, examiner names, art units, deadlines, or rejection types.
- "(not in record)" semantics: if you don't see it in the data, leave it empty. The renderer will print "(not in record)" for empty fields.
- recommendedNextStep MUST be specific (concrete action with a deadline or trigger), not generic. If you don't have enough information for a specific recommendation, write "Insufficient data to recommend a specific next step — confirm application number and pull latest OA before proceeding."
- openIssues.issueType uses standard rejection/objection labels (§101, §102, §103, §112(a), §112(b), §112(d), §171, restriction, double-patenting, formalities).
- outstandingDeadlines.date should be the deadline date itself, not the action date that triggered it.

Example shape (illustrative, do not copy values):
{
  "applicationNumber": "17/123,456",
  "filingDate": "2021-03-15",
  "status": "Awaiting Examiner Action",
  "latestActionType": "Non-final OA",
  "latestActionDate": "2026-03-15",
  "examinerName": "RILEY, JEZIA",
  "artUnit": "1637",
  "outstandingDeadlines": [
    { "description": "Statutory response to non-final OA", "date": "2026-06-15" }
  ],
  "openIssues": [
    { "issueType": "§103", "affectedClaims": ["1", "3", "5-7"] }
  ],
  "recommendedNextStep": "Draft response to §103 rejection of claims 1, 3, 5-7 by 2026-06-15."
}`;

export async function getCaseStatus(
  usptoJson: string,
  uploadedDocsSummary: string,
  opts: { maxAttempts?: number } = {},
): Promise<CaseStatus> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const prompt = `USPTO Open Data Portal (raw JSON):
${usptoJson}

Uploaded case documents (summary):
${uploadedDocsSummary}

Produce the status card. Use empty string / empty array for anything not literally present in the data above. Output the JSON object now.`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { object } = await generateObject({
        model: chatModel,
        schema: ModelOutputSchema,
        system: STATUS_SYSTEM,
        prompt,
        temperature: 0.1,
        providerOptions: { ollama: { format: "json" } },
      });
      return synthesizeRecommendation(object);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) console.warn(`[case-status] attempt ${attempt} failed, retrying...`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`getCaseStatus failed after ${maxAttempts} attempts`);
}

// Synthesize a fallback recommendedNextStep when the model omitted it.
// Prefer concrete: tie to the earliest outstanding deadline if any;
// else the first open issue; else explicitly flag insufficient data.
function synthesizeRecommendation(s: CaseStatus): CaseStatus {
  if (s.recommendedNextStep && s.recommendedNextStep.trim().length > 0) return s;

  const firstDeadline = s.outstandingDeadlines.find((d) => d.date && d.description);
  if (firstDeadline) {
    return {
      ...s,
      recommendedNextStep: `${firstDeadline.description} by ${firstDeadline.date}.`,
    };
  }
  const firstIssue = s.openIssues[0];
  if (firstIssue) {
    const claimsClause = firstIssue.affectedClaims.length > 0
      ? ` (claims ${firstIssue.affectedClaims.join(", ")})`
      : "";
    return {
      ...s,
      recommendedNextStep: `Address outstanding ${firstIssue.issueType} rejection${claimsClause} in the next filing.`,
    };
  }
  return {
    ...s,
    recommendedNextStep: "Insufficient data to recommend a specific next step — confirm application number, pull latest USPTO file wrapper, then re-run.",
  };
}

export function renderCaseStatusMarkdown(s: CaseStatus): string {
  const field = (v: string) => (v && v.trim().length > 0 ? v : "_(not in record)_");
  const lines: string[] = [];
  lines.push(`- **Application:** ${field(s.applicationNumber)} | ${field(s.filingDate)} | ${field(s.status)}`);
  lines.push(`- **Latest action:** ${field(s.latestActionType)} | ${field(s.latestActionDate)} | ${field(s.examinerName)}${s.artUnit ? ` (art unit ${s.artUnit})` : ""}`);
  if (s.outstandingDeadlines.length > 0) {
    lines.push(`- **Outstanding deadlines:**`);
    for (const d of s.outstandingDeadlines) {
      lines.push(`  - ${d.description}${d.date ? ` — ${d.date}` : ""}`);
    }
  } else {
    lines.push(`- **Outstanding deadlines:** _(none in record)_`);
  }
  if (s.openIssues.length > 0) {
    lines.push(`- **Open issues:**`);
    for (const issue of s.openIssues) {
      lines.push(`  - ${issue.issueType}${issue.affectedClaims.length > 0 ? ` (claims ${issue.affectedClaims.join(", ")})` : ""}`);
    }
  } else {
    lines.push(`- **Open issues:** _(none in record)_`);
  }
  lines.push(`- **Recommended next step:** ${s.recommendedNextStep || "_(no specific recommendation — insufficient data)_"}`);
  return lines.join("\n");
}
