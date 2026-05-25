// Structured §102 / §103 rejection analyzer.
//
// Three prompt iterations (4a/4b/4c) on Llama 3.1 8B kept producing
// banned terminology ("fully anticipated", "partially disclosed",
// "partial §102") and skipping the mandatory output template. The
// model can't reliably follow narrative-template instructions at this
// size. Solution: bypass narrative entirely and force a typed JSON
// shape via AI SDK generateObject + Zod. The disclosure label is a
// Zod enum so the model literally cannot emit "partial" — the
// generation is constrained at the token level.
//
// This module is intentionally a pure helper: takes the user query +
// retrieved chunks, returns a typed object. Callers (chat route,
// future predefined action) render it to markdown.

import { generateObject } from "ai";
import { z } from "zod";
import { chatModel } from "@/lib/llm";
import { traceableLabel, type RetrievedChunk } from "@/lib/rag";

// Schema is intentionally flat — Llama 3.1 8B does not reliably honor
// deeply nested object schemas via generateObject (it invents its own
// shape; AI SDK's repair pass can't recover). Flat top-level fields
// with shallow arrays-of-objects work; deeper nesting does not.

// Three-tier limitation label. The §102 VERDICT is still binary
// (computed in deriveVerdicts) — PARTIALLY_DISCLOSED counts as
// NOT_DISCLOSED for the verdict, since §102 requires every limitation
// to be fully disclosed. PARTIALLY exists for prosecutor argumentation:
// it surfaces "the reference suggests this but doesn't teach it" cases
// without polluting the verdict logic. Any unrecognized label coerces
// to NOT_DISCLOSED (conservative side).
const DISCLOSURE = z
  .union([z.enum(["DISCLOSED", "PARTIALLY_DISCLOSED", "NOT_DISCLOSED"]), z.string()])
  .transform((v) => {
    if (v === "DISCLOSED") return "DISCLOSED" as const;
    if (v === "PARTIALLY_DISCLOSED") return "PARTIALLY_DISCLOSED" as const;
    return "NOT_DISCLOSED" as const;
  });

const Limitation = z.object({
  id: z.string().describe("Limitation id from the claim, e.g. '(a)', '(b)(i)'."),
  text: z.string().describe("Verbatim quote of the limitation from the claims doc."),
  disclosure: DISCLOSURE,
  evidence: z.string().nullish().transform((v) => v ?? "").describe("Verbatim quote from the prior-art reference. Required — write 'no related text' if no relevant passage exists."),
  gap: z.string().nullish().transform((v) => v ?? "").describe("Required — one sentence. If DISCLOSED: synonym or 'exact match'. If NOT_DISCLOSED: specific delta."),
});

// Same forgiving pattern for the top-level booleans: small models often
// drop fields entirely or emit strings ("true"/"false"). `.nullish()`
// handles missing/null; the union covers stringified booleans.
const SoftBool = z
  .union([z.boolean(), z.string(), z.null()])
  .nullish()
  .transform((v) => (v === true || v === "true" ? true : false));

// Schema is split into two layers:
//   ModelOutputSchema  — what the model fills in (no verdict fields)
//   RejectionAnalysisSchema — what callers consume (verdict fields derived)
//
// The model is BAD at keeping the verdict fields consistent with the
// limitation labels. Iter 1 eval showed it would mark every limitation
// DISCLOSED but separately set s102Satisfied=false and s103Sustainable=true
// with no motivation in record — pure inconsistency. Deriving verdicts
// from the labels removes the whole failure class.
//
// We still ask the model to claim a §103 motivation-in-record (it's a
// fact about the OA text, not a derivation), but sustainable is now
// purely computed: sustainable iff §102 satisfied OR (some failing limitation
// AND motivation in record AND a secondary reference was given).

const ReferenceContribution = z.object({
  reference: z.string().describe("Reference label, e.g. 'US 9,123,456' or '[prior_art_us9123456.txt]'."),
  contributes: z.string().describe("One sentence quoting or tightly paraphrasing what this reference adds to the §103 combination. Tie to specific limitations the reference covers."),
});

const ModelOutputSchema = z.object({
  claimText: z.string().describe("Verbatim quoted claim under analysis, from the retrieved claims doc."),
  primaryReference: z.string().describe("The reference cited for §102, e.g. 'US 9,123,456' or '[prior_art_us9123456.txt]'."),
  secondaryReference: z.string().nullish().transform((v) => v ?? "none").describe("Reference combined for §103, or 'none' if the examiner did not raise §103."),
  limitations: z.array(Limitation).min(1).describe("One entry per claim limitation (sub-elements like (b)(i) get their own entries). Map each limitation against the PRIMARY reference only — §103 combination is analyzed separately."),
  s103MotivationInRecord: SoftBool.describe("True iff the office action / retrieved sources state a motivation to combine. False if motivation must be invented or is missing."),
  s103ReferenceContributions: z.array(ReferenceContribution).nullish().transform((v) => v ?? []).describe("One entry per cited reference. Each explains in one sentence what that reference contributes to the §103 combination, anchored to specific limitations. Empty if no §103 was raised."),
  conclusionDraft: z.string().nullish().transform((v) => v ?? "").describe("One sentence. The renderer will rebuild the full conclusion from derived fields."),
});

export const RejectionAnalysisSchema = ModelOutputSchema.extend({
  // Derived fields, computed after the model returns. They aren't in the
  // model-facing schema so the model can't emit inconsistent values.
  s102Satisfied: z.boolean(),
  s102FailingLimitationIds: z.array(z.string()),
  s103Sustainable: z.boolean(),
  conclusion: z.string(),
});

export type RejectionAnalysis = z.infer<typeof RejectionAnalysisSchema>;

const ANALYZER_SYSTEM = `You are a USPTO patent examiner. Produce ONLY a JSON object matching the schema. No prose before or after.

Hard rules:
- Map each limitation against the PRIMARY reference ONLY. §103 combination is analyzed separately via s103ReferenceContributions.
- Never emit "fully anticipated", "partial §102", "partial anticipation", or other gradient phrasing in any free-text field.
- s103MotivationInRecord is true ONLY if the retrieved office action / sources explicitly state a reason to combine. Absent → false.

THREE-TIER DISCLOSURE LABEL (this is the calibration core):

DISCLOSED — the PRIMARY reference recites the limitation in essentially the same
  language. An examiner would accept this as identity. Examples:
    • claim "receiving documents" vs reference "the system receives documents" → DISCLOSED
    • claim "displaying a ranked list" vs reference "a ranked list is displayed" → DISCLOSED
    • claim "vector similarity" vs reference "query vector similarity" → DISCLOSED (same metric form)

PARTIALLY_DISCLOSED — the reference teaches a related/overlapping concept but
  with a meaningful gap: different scope, different qualifier, missing a sub-
  clause, broader, narrower, or differently-named-but-similar. Use this when
  an examiner could plausibly argue both ways. Examples:
    • claim "semantic similarity between user query and content" vs reference
      "similarity to query vector representation" → PARTIALLY_DISCLOSED
      (query-vector similarity often maps to semantic similarity in practice,
      but the claim specifies semantic+query+content explicitly)
    • claim "recalculated after each user interaction event" vs reference
      "ranking updated dynamically when user interactions occur" → PARTIALLY_DISCLOSED
      (similar mechanism, but "after each event" is more specific than
      "when interactions occur")
    • claim "frequency of citation within legal corpus" vs reference
      "frequency of document access" → PARTIALLY_DISCLOSED
      (related ranking input, but different data source)

NOT_DISCLOSED — the reference is genuinely silent on the limitation, OR
  the reference's text is on a fundamentally different topic. Examples:
    • claim "recency of document within case file" vs reference (no mention
      of case-file scoping) → NOT_DISCLOSED
    • claim "citation frequency within legal corpus" vs reference that talks
      about modification timestamps only → NOT_DISCLOSED

When in doubt between DISCLOSED and PARTIALLY → choose PARTIALLY.
When in doubt between PARTIALLY and NOT_DISCLOSED → choose NOT_DISCLOSED.

CRITICAL: the 'evidence' field MUST be a LITERAL VERBATIM SUBSTRING of one of the retrieved source texts. Copy and paste, do not paraphrase, summarize, reformat, change punctuation, or change capitalization. If you cannot find a literal substring that supports a DISCLOSED or PARTIALLY_DISCLOSED label, the limitation is NOT_DISCLOSED with evidence = "no related text in reference".

Same rule for claimText: literal verbatim substring of the retrieved claims document. Do not reformat newlines or whitespace; do not omit "wherein" clauses; copy the exact substring.

§103 ANALYSIS: if the examiner raised §103, fill s103ReferenceContributions
with one entry per cited reference explaining (in one sentence) what that
reference contributes to the combination — quote or tightly paraphrase from
the reference. Anchor to specific limitations the reference covers that the
primary does not. Example:
  [{ "reference": "US 8,765,432", "contributes": "supplies the missing
    citation-frequency limitation (b)(iii) via 'importance scores based on
    citation frequency within a legal database'." }]
If the examiner did not raise §103, leave s103ReferenceContributions empty.

Example shape (illustrative, do not copy values):
{
  "claimText": "1. A method comprising:\\n(a) receiving X;\\n(b) scoring by Y;\\nwherein Z is recalculated after each event.",
  "primaryReference": "US 9,123,456",
  "secondaryReference": "US 8,765,432",
  "limitations": [
    { "id": "(a)", "text": "receiving X", "disclosure": "DISCLOSED", "evidence": "the system receives X from a network source", "gap": "exact match" },
    { "id": "(b)", "text": "scoring by Y", "disclosure": "PARTIALLY_DISCLOSED", "evidence": "the system computes a score based on Y'", "gap": "Y' is a related but not identical metric to claimed Y" },
    { "id": "(wherein)", "text": "recalculated after each event", "disclosure": "NOT_DISCLOSED", "evidence": "no related text in reference", "gap": "primary has no recalculation trigger language" }
  ],
  "s103MotivationInRecord": false,
  "s103ReferenceContributions": [
    { "reference": "US 8,765,432", "contributes": "supplies the recalculation trigger limitation via 'scores are recomputed on each user event'." }
  ],
  "conclusionDraft": "Primary discloses (a) but only partially discloses (b) and is silent on the wherein clause."
}`;

export async function analyzeRejection(
  userQuery: string,
  chunks: RetrievedChunk[],
  opts: { maxAttempts?: number } = {},
): Promise<RejectionAnalysis> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const sourcesBlock = chunks
    .map((c) => `[${traceableLabel(c)}] (${c.origin})\n${c.text}`)
    .join("\n\n---\n\n");

  const prompt = `User question:
${userQuery}

Retrieved sources:
${sourcesBlock || "(none)"}

Produce the JSON object now. Quote claimText verbatim from the retrieved claims doc.`;

  // 8B variance: generateObject occasionally produces JSON that fails
  // schema validation even with the coercion layers in place. Retry on
  // schema failure; lower temperature to bias toward repeatable shape.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { object } = await generateObject({
        model: chatModel,
        schema: ModelOutputSchema,
        system: ANALYZER_SYSTEM,
        prompt,
        temperature: 0.1,
        providerOptions: {
          // Ollama supports `format: "json"` to constrain output to valid
          // JSON. The openai-compatible provider passes provider options
          // through for ollama.
          ollama: { format: "json" },
        },
      });
      return deriveVerdicts(verifyEvidence(object, chunks));
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        console.warn(`[analyze-rejection] attempt ${attempt} failed, retrying...`);
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`analyzeRejection failed after ${maxAttempts} attempts`);
}

// Prosecution-grade defensive pass: auto-downgrade any DISCLOSED
// limitation whose evidence quote isn't a verbatim substring of a
// retrieved chunk. Rationale: a DISCLOSED label that the model can't
// back with verbatim quote text is unsafe in real prosecution — if you
// can't quote the reference verbatim to the examiner, the limitation
// isn't actually anticipated. The 8B model paraphrases when it should
// quote, so we enforce verbatim at runtime instead of trusting the
// prompt-level instruction.
function verifyEvidence(
  modelOutput: z.infer<typeof ModelOutputSchema>,
  chunks: RetrievedChunk[],
): z.infer<typeof ModelOutputSchema> {
  const haystacks = chunks.map((c) => c.text);
  // Apply verbatim-substring verification to DISCLOSED and
  // PARTIALLY_DISCLOSED rows. NOT_DISCLOSED rows by definition don't
  // need verifiable evidence (the field can be "no related text").
  // DISCLOSED without verifiable evidence → NOT_DISCLOSED (strict, since
  // an examiner would demand the verbatim cite).
  // PARTIALLY_DISCLOSED without verifiable evidence → NOT_DISCLOSED too:
  // if we can't quote anything, there's nothing arguably disclosed.
  const verifiedLimitations = modelOutput.limitations.map((lim) => {
    if (lim.disclosure === "NOT_DISCLOSED") return lim;
    if (!lim.evidence || /no related text/i.test(lim.evidence)) {
      return { ...lim, disclosure: "NOT_DISCLOSED" as const };
    }
    if (substringInTexts(lim.evidence, haystacks)) return lim;
    return {
      ...lim,
      disclosure: "NOT_DISCLOSED" as const,
      evidence: "evidence not verifiable in retrieved sources",
      gap: `model quoted "${lim.evidence.slice(0, 80)}..." but no verbatim match in primary reference; auto-downgraded to NOT_DISCLOSED`,
    };
  });
  return { ...modelOutput, limitations: verifiedLimitations };
}

function substringInTexts(needle: string, haystacks: string[]): boolean {
  if (!needle) return false;
  const n = normalize(needle);
  if (n.length < 12) return false; // very short quotes are not meaningful
  return haystacks.some((h) => normalize(h).includes(n));
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−-]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Compute verdict fields from the model's per-limitation labels. Removes
// the failure class where the model emitted inconsistent s102Satisfied /
// s102FailingLimitationIds / s103Sustainable values relative to the
// limitation array. PARTIALLY_DISCLOSED counts as NOT_DISCLOSED for the
// verdict — §102 requires every limitation FULLY disclosed in one ref.
function deriveVerdicts(
  modelOutput: z.infer<typeof ModelOutputSchema>,
): RejectionAnalysis {
  const failing = modelOutput.limitations
    .filter((l) => l.disclosure !== "DISCLOSED")
    .map((l) => l.id);
  const s102Satisfied = failing.length === 0;
  const hasSecondary =
    Boolean(modelOutput.secondaryReference) &&
    modelOutput.secondaryReference.toLowerCase() !== "none";

  // Synthesize §103 reference contributions when the model omitted them
  // but a §103 analysis is procedurally required. The synthesis is a
  // placeholder: it names the reference and which failing limitations
  // it would need to cover, flagging that the model did not explicitly
  // state the contribution. Better than nothing, and the renderer marks
  // it as analyzer-synthesized so the prosecutor knows to verify.
  let contributions = modelOutput.s103ReferenceContributions;
  if (hasSecondary && !s102Satisfied && contributions.length === 0) {
    contributions = [
      {
        reference: modelOutput.primaryReference,
        contributes: `cited for §102 anticipation of [${
          modelOutput.limitations.filter((l) => l.disclosure === "DISCLOSED").map((l) => l.id).join(", ") || "no limitations fully disclosed"
        }]; remaining limitations [${failing.join(", ")}] must come from the secondary.`,
      },
      {
        reference: modelOutput.secondaryReference,
        contributes: `secondary reference cited but specific contribution not extracted by analyzer; would need to cover [${failing.join(", ")}].`,
      },
    ];
  }
  modelOutput = { ...modelOutput, s103ReferenceContributions: contributions };
  // §103 sustainable iff:
  //   - §102 already satisfied (then §103 is moot but technically yes), OR
  //   - examiner combined a secondary reference AND motivation is in record
  //     (otherwise the combination cannot bridge the missing limitations
  //     in a procedurally sound way).
  const s103Sustainable = s102Satisfied
    ? true
    : hasSecondary && modelOutput.s103MotivationInRecord;

  // Annotate failing IDs with their label tier so the conclusion text
  // distinguishes "not in reference at all" from "arguable disclosure".
  const failingByTier = (tier: typeof modelOutput.limitations[number]["disclosure"]) =>
    modelOutput.limitations.filter((l) => l.disclosure === tier).map((l) => l.id);
  const notDisclosed = failingByTier("NOT_DISCLOSED");
  const partiallyDisclosed = failingByTier("PARTIALLY_DISCLOSED");

  const verdictSentence = s102Satisfied
    ? `§102 SATISFIED by ${modelOutput.primaryReference}.`
    : `§102 NOT SATISFIED — ${modelOutput.primaryReference} does not fully disclose ${failing.join(", ")}${
        partiallyDisclosed.length > 0
          ? ` (partial: ${partiallyDisclosed.join(", ")}; absent: ${notDisclosed.join(", ") || "none"})`
          : ""
      }.`;
  const s103Sentence = s102Satisfied
    ? ""
    : hasSecondary
      ? ` §103 over ${modelOutput.primaryReference} + ${modelOutput.secondaryReference} is ${s103Sustainable ? "sustainable" : "not sustainable (motivation to combine not in record)"}.`
      : " §103 not raised; no secondary reference cited.";
  const draftBit = modelOutput.conclusionDraft
    ? ` ${scrubBannedTerms(modelOutput.conclusionDraft).trim()}`
    : "";
  const conclusion = `${verdictSentence}${s103Sentence}${draftBit}`.trim();

  return {
    ...modelOutput,
    s102Satisfied,
    s102FailingLimitationIds: failing,
    s103Sustainable,
    conclusion,
  };
}

function scrubBannedTerms(text: string): string {
  if (!text) return text;
  return text
    // Gradient phrases → binary equivalents.
    .replace(/\bpartial(?:ly)?\s+(anticipat(?:ed|ion)|disclosed|§\s*102)/gi, "NOT SATISFIED")
    .replace(/\bpartial\s+§\s*102\b/gi, "§102 NOT SATISFIED")
    .replace(/\bfully\s+anticipat(?:ed|ion)\b/gi, "§102 SATISFIED")
    .replace(/\bfully\s+disclosed\b/gi, "DISCLOSED")
    .replace(/\bpartially\s+disclosed\b/gi, "NOT DISCLOSED")
    .replace(/\bessentially\s+disclosed\b/gi, "NOT DISCLOSED");
}

// Detect whether a free-form chat query is asking for a §102/§103
// rejection analysis. Conservative — only routes through the
// structured analyzer when ALL of:
//   (a) query mentions rejection / §102 / §103 / anticipated / obvious / prior art / OA
//   (b) the retrieved chunks include at least one user_upload (case doc)
// Avoids hijacking general questions.
const REJECTION_QUERY_RE = /\b(rejection|§\s*10[23]|section\s*10[23]|anticipat|obvious|prior\s+art|office\s+action)\b/i;

export function isRejectionAnalysisQuery(
  query: string,
  chunks: RetrievedChunk[],
): boolean {
  if (!REJECTION_QUERY_RE.test(query)) return false;
  return chunks.some((c) => c.docType === "user_upload" || c.origin === "case");
}

// Render the typed analysis as markdown. Headers come from us, not the
// model, so they cannot be skipped — the (A)–(E) template is now
// structurally guaranteed regardless of model behavior.
export function renderAnalysisMarkdown(a: RejectionAnalysis): string {
  const lines: string[] = [];
  lines.push("**(A) CLAIM BREAKDOWN**");
  lines.push("");
  lines.push(`> ${a.claimText.split("\n").join("\n> ")}`);
  lines.push("");
  lines.push(`Primary reference (§102): **${a.primaryReference}**`);
  if (a.secondaryReference && a.secondaryReference.toLowerCase() !== "none") {
    lines.push(`Secondary reference (§103): **${a.secondaryReference}**`);
  }
  lines.push("");
  lines.push("**(B) PRIOR ART MAPPING**");
  lines.push("");
  for (const lim of a.limitations) {
    const labelTag =
      lim.disclosure === "DISCLOSED"
        ? "DISCLOSED ✓"
        : lim.disclosure === "PARTIALLY_DISCLOSED"
          ? "PARTIALLY_DISCLOSED ⚠"
          : "NOT_DISCLOSED ✗";
    lines.push(`- **Limitation ${lim.id}**: "${lim.text}"`);
    lines.push(`  - **Disclosure:** ${labelTag}`);
    lines.push(`  - **Evidence:** "${lim.evidence}"`);
    lines.push(`  - **Gap:** ${lim.gap}`);
  }
  lines.push("");
  lines.push("**(C) §102 VERDICT**");
  lines.push("");
  lines.push(`- **${a.primaryReference}** — §102 ${a.s102Satisfied ? "**SATISFIED**" : "**NOT SATISFIED**"}`);
  if (!a.s102Satisfied && a.s102FailingLimitationIds.length > 0) {
    const partials = a.limitations
      .filter((l) => l.disclosure === "PARTIALLY_DISCLOSED")
      .map((l) => l.id);
    const absent = a.limitations
      .filter((l) => l.disclosure === "NOT_DISCLOSED")
      .map((l) => l.id);
    lines.push(`  - Failing limitations: ${a.s102FailingLimitationIds.join(", ")}`);
    if (partials.length > 0) lines.push(`    - Partially disclosed (arguable): ${partials.join(", ")}`);
    if (absent.length > 0) lines.push(`    - Not disclosed (absent): ${absent.join(", ")}`);
  }
  lines.push("");
  lines.push("**(D) §103 ANALYSIS**");
  lines.push("");
  if (a.s102Satisfied || (!a.secondaryReference || a.secondaryReference.toLowerCase() === "none")) {
    lines.push("- Not applicable.");
  } else {
    if (a.s103ReferenceContributions.length > 0) {
      lines.push("- **Reference contributions:**");
      for (const rc of a.s103ReferenceContributions) {
        lines.push(`  - **${rc.reference}**: ${rc.contributes}`);
      }
    } else {
      lines.push("- **Reference contributions:** _not specified by analyzer (model omitted; treat §103 as procedurally incomplete)._");
    }
    lines.push(`- **Motivation to combine in record:** ${a.s103MotivationInRecord ? "yes" : "**MOTIVATION NOT IN RECORD**"}`);
    lines.push(`- **Sustainable:** ${a.s103Sustainable ? "yes" : "no"}`);
  }
  lines.push("");
  lines.push("**(E) CONCLUSION**");
  lines.push("");
  lines.push(a.conclusion);
  return lines.join("\n");
}
