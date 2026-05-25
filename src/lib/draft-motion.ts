// Structured "draft next motion" analyzer.
//
// Generates a recommended next filing (response to OA, RCE, appeal
// brief, etc.) along with a draft body. The draft itself is free text,
// but the surrounding scaffold is structured so the prosecutor gets a
// commitment on document type and a verifiable list of cited
// authorities + referenced claims.
//
// Key constraint: canDraftFromSources is binary. If retrieval is too
// thin to support a real draft (no OA, no claim text, no spec), the
// model MUST flag it and leave draftBody empty rather than fabricate.

import { generateObject } from "ai";
import { z } from "zod";
import { chatModel } from "@/lib/llm";
import { traceableLabel, type RetrievedChunk } from "@/lib/rag";

const DocumentType = z.enum([
  "RESPONSE_NON_FINAL_OA",
  "RESPONSE_FINAL_OA",
  "RCE_WITH_AMENDMENT",
  "AMENDMENT_ONLY",
  "APPEAL_BRIEF",
  "PRE_APPEAL_BRIEF_CONFERENCE",
  "INTERVIEW_REQUEST",
  "RESPONSE_TO_RESTRICTION",
  "RESPONSE_TO_QUAYLE",
  "INFORMATION_DISCLOSURE_STATEMENT",
  "PETITION",
  "OTHER",
]);

const SoftDocType = z
  .union([DocumentType, z.string()])
  .transform((v) => (DocumentType.safeParse(v).success ? (v as z.infer<typeof DocumentType>) : "OTHER"));

const SoftBool = z
  .union([z.boolean(), z.string(), z.null()])
  .nullish()
  .transform((v) => (v === true || v === "true" ? true : false));

const CitedAuthority = z.object({
  label: z.string().describe("Traceable label exactly as it appears in the retrieval block, e.g. '[MPEP § 2131]' or '[35 U.S.C. § 103]'."),
  proposition: z.string().describe("One sentence: what proposition this authority supports in the draft."),
});

const ModelOutputSchema = z.object({
  nextDocumentType: SoftDocType,
  nextDocumentTypeReason: z.string().describe("One sentence anchored to a case fact (status, OA type, deadline, finality). Cite a [label] when possible."),
  canDraftFromSources: SoftBool.describe("True iff the retrieved sources contain enough material (claim text + OA + applicable authority) to write a defensible draft. False → draftBody MUST be empty."),
  draftBody: z.string().nullish().transform((v) => v ?? "").describe("Free-text draft. Multi-paragraph OK. Empty string if canDraftFromSources=false."),
  claimsReferenced: z.array(z.string()).nullish().transform((v) => v ?? []).describe("List of claim numbers actually referenced in the draft, e.g. ['1', '4', '7-10']. Empty if no draft."),
  authoritiesCited: z.array(CitedAuthority).nullish().transform((v) => v ?? []).describe("Authorities cited in the draft. Labels MUST appear verbatim in the retrieval block — never invent."),
  openQuestions: z.array(z.string()).nullish().transform((v) => v ?? []).describe("Specific decisions the prosecutor needs to make before filing (e.g. 'Decide whether to argue (b)(i) under §112 written description or §103')."),
});

export const DraftedMotionSchema = ModelOutputSchema;
export type DraftedMotion = z.infer<typeof DraftedMotionSchema>;

const DRAFT_SYSTEM = `You are a registered patent practitioner drafting the next filing for a prosecution case. Output ONLY a JSON object matching the schema. No prose before or after.

Hard rules:
- nextDocumentType is one enum value chosen based on case status (non-final OA → RESPONSE_NON_FINAL_OA; final OA → RESPONSE_FINAL_OA or RCE_WITH_AMENDMENT; restriction → RESPONSE_TO_RESTRICTION; etc.).
- canDraftFromSources is the gate. If you do not have BOTH the claim text AND the OA text in the retrieval block, set canDraftFromSources=false and draftBody="". Do NOT fabricate claim text, OA reasoning, or applicant arguments.
- draftBody, when present, is real prose suitable for filing — caption-less is OK, but the substance should be defensible:
    • address each rejection in the OA explicitly (don't merge them)
    • cite authorities by [label] from the retrieval block
    • for argument-based responses, give the technical distinction explicitly (not "Applicant respectfully traverses")
    • for amendments, identify the spec support
- claimsReferenced MUST list the claim numbers you actually reference in draftBody.
- authoritiesCited: each entry's 'label' MUST appear verbatim in the retrieval block. If you want to cite something not retrieved, add it to openQuestions instead.
- openQuestions: be specific. "Confirm with client" is bad. "Decide whether to amend claim 1 to require XYZ — confirm spec support at ¶[0042]" is good.
- Never invent application numbers, examiner names, dates, or holdings.
- Forbidden phrases in draftBody: "Applicant respectfully submits that the references fail to teach", "It is respectfully submitted", "the Office's rejection should be reconsidered" without a specific technical reason.

Document type enum (use exactly one):
  RESPONSE_NON_FINAL_OA, RESPONSE_FINAL_OA, RCE_WITH_AMENDMENT,
  AMENDMENT_ONLY, APPEAL_BRIEF, PRE_APPEAL_BRIEF_CONFERENCE,
  INTERVIEW_REQUEST, RESPONSE_TO_RESTRICTION, RESPONSE_TO_QUAYLE,
  INFORMATION_DISCLOSURE_STATEMENT, PETITION, OTHER

Example shape (illustrative, do not copy values):
{
  "nextDocumentType": "RESPONSE_NON_FINAL_OA",
  "nextDocumentTypeReason": "Non-final OA mailed 2026-03-15 ([office_action.txt]); three-month statutory response window not yet expired.",
  "canDraftFromSources": true,
  "draftBody": "Argument: Claim 1 is not anticipated by Smith because [...]\\n\\nAmendment: Claim 1, line 4, after 'a relevance score', insert 'computed from semantic-vector similarity'.",
  "claimsReferenced": ["1", "4", "7"],
  "authoritiesCited": [
    { "label": "[MPEP § 2131]", "proposition": "anticipation requires that every element be disclosed in a single reference" },
    { "label": "[35 U.S.C. § 102]", "proposition": "novelty standard" }
  ],
  "openQuestions": [
    "Confirm spec support for proposed amendment to claim 1 — see ¶[0042] vs claim's broader scope"
  ]
}`;

export async function draftNextMotion(
  caseSummary: string,
  chunks: RetrievedChunk[],
  opts: { maxAttempts?: number } = {},
): Promise<DraftedMotion> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const sourcesBlock = chunks
    .map((c) => `[${traceableLabel(c)}] (${c.origin})\n${c.text}`)
    .join("\n\n---\n\n");

  const prompt = `Case summary:
${caseSummary}

Retrieved sources:
${sourcesBlock || "(none)"}

Determine the next document to file and draft it if the sources support a defensible draft. Output the JSON object now.`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { object } = await generateObject({
        model: chatModel,
        schema: ModelOutputSchema,
        system: DRAFT_SYSTEM,
        prompt,
        temperature: 0.1,
        providerOptions: { ollama: { format: "json" } },
      });
      return verifyAuthorities(object, chunks);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) console.warn(`[draft-motion] attempt ${attempt} failed, retrying...`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`draftNextMotion failed after ${maxAttempts} attempts`);
}

// Verify that each cited authority label appears verbatim in some
// retrieved chunk's traceable label. If not, drop it from
// authoritiesCited and surface in openQuestions so the prosecutor sees
// the model's hallucinated citation as a "verify this" item rather than
// a silent error.
function verifyAuthorities(
  modelOutput: z.infer<typeof ModelOutputSchema>,
  chunks: RetrievedChunk[],
): DraftedMotion {
  const validLabels = new Set(chunks.map((c) => `[${traceableLabel(c)}]`.toLowerCase()));
  const verified: typeof modelOutput.authoritiesCited = [];
  const flagged: string[] = [];
  for (const auth of modelOutput.authoritiesCited) {
    const norm = auth.label.toLowerCase().trim();
    const matched = [...validLabels].some((v) => norm.includes(v) || v.includes(norm));
    if (matched) verified.push(auth);
    else flagged.push(`Verify authority "${auth.label}" — not in retrieved sources. Proposition: ${auth.proposition}`);
  }
  return {
    ...modelOutput,
    authoritiesCited: verified,
    openQuestions: [...modelOutput.openQuestions, ...flagged],
  };
}

export function renderDraftedMotionMarkdown(m: DraftedMotion): string {
  const lines: string[] = [];
  lines.push(`**Next document:** **${m.nextDocumentType}**`);
  lines.push(`_${m.nextDocumentTypeReason}_`);
  lines.push("");
  if (m.canDraftFromSources && m.draftBody.trim().length > 0) {
    lines.push("**Draft**");
    lines.push("");
    lines.push(m.draftBody);
    lines.push("");
    if (m.claimsReferenced.length > 0) {
      lines.push(`**Claims referenced:** ${m.claimsReferenced.join(", ")}`);
      lines.push("");
    }
    if (m.authoritiesCited.length > 0) {
      lines.push("**Authorities cited**");
      lines.push("");
      for (const a of m.authoritiesCited) {
        lines.push(`- ${a.label} — ${a.proposition}`);
      }
      lines.push("");
    }
  } else {
    lines.push("**Draft skipped** — retrieved sources are insufficient to write a defensible draft (need claim text + office action + relevant authority).");
    lines.push("");
  }
  if (m.openQuestions.length > 0) {
    lines.push("**Open questions for the practitioner**");
    lines.push("");
    for (const q of m.openQuestions) {
      lines.push(`- ${q}`);
    }
  }
  return lines.join("\n");
}
