// Structured amendment / response drafter.
//
// Takes the output of analyze-rejection and turns it into the document a
// prosecutor actually files: a claim listing marked up per 37 C.F.R. § 1.121,
// plus remarks traversing each rejection.
//
// Why it consumes the analysis rather than re-deriving it: which limitations
// fail is already decided by analyzeRejection's derived verdicts. Asking a
// second model call to re-decide invites the two to disagree, and a response
// whose remarks contradict its own claim amendments is worse than no draft.
//
// Grounding is unchanged from the rest of the app. The office action and the
// current claims are both in the record, so nothing here needs an exception to
// the no-unsourced-facts rule -- unlike application drafting, which does.

import { generateObject } from "ai";
import { z } from "zod";
import { REASONING } from "@/lib/llm";
import { traceableLabel, type RetrievedChunk } from "@/lib/rag";
import type { RejectionAnalysis } from "@/lib/analyze-rejection";

// 37 C.F.R. § 1.121(c) requires every claim to carry a parenthetical status
// identifier, and requires the listing to include ALL claims ever presented,
// in ascending order -- not just the ones being changed. Getting this wrong is
// a formal defect that draws a notice of non-compliant amendment.
const StatusIdentifier = z.enum([
  "ORIGINAL",
  "CURRENTLY_AMENDED",
  "PREVIOUSLY_PRESENTED",
  "CANCELED",
  "WITHDRAWN",
  "NEW",
]);

const SoftStatus = z
  .union([StatusIdentifier, z.string()])
  .transform((v) =>
    StatusIdentifier.safeParse(v).success
      ? (v as z.infer<typeof StatusIdentifier>)
      : "PREVIOUSLY_PRESENTED",
  );

const ResponseType = z.enum([
  "AMENDMENT_AND_REMARKS",
  "REMARKS_ONLY",
  "RCE_WITH_AMENDMENT",
  "AFTER_FINAL_AMENDMENT",
  "OTHER",
]);

const SoftResponseType = z
  .union([ResponseType, z.string()])
  .transform((v) => (ResponseType.safeParse(v).success ? (v as z.infer<typeof ResponseType>) : "OTHER"));

const SoftBool = z
  .union([z.boolean(), z.string(), z.null()])
  .nullish()
  .transform((v) => (v === true || v === "true" ? true : false));

const ClaimEntry = z.object({
  claimNumber: z.string().describe("Claim number as a string, e.g. '1'."),
  status: SoftStatus.describe("37 CFR 1.121(c) status identifier for this claim."),
  text: z
    .string()
    .nullish()
    .transform((v) => v ?? "")
    .describe(
      "Full claim text as it will read AFTER amendment. Mark insertions with <u>...</u> and deletions with <s>...</s>. Empty only for CANCELED claims.",
    ),
  changeSummary: z
    .string()
    .nullish()
    .transform((v) => v ?? "")
    .describe("One sentence: what changed and which rejected limitation it addresses. Empty for ORIGINAL/unchanged claims."),
  supportCitation: z
    .string()
    .nullish()
    .transform((v) => v ?? "")
    .describe(
      "Where the added language finds written-description support, quoted or cited from a retrieved source, e.g. '[claims2.txt] recalculated after each user interaction event'. Empty if nothing was added.",
    ),
});

const RemarkEntry = z.object({
  rejectionAddressed: z
    .string()
    .describe("Which rejection this argument answers, e.g. '§102 over US 9,123,456' or '§103 over 456 in view of 432'."),
  argument: z.string().describe("The traversal argument. Substantive, tied to specific claim limitations."),
  authorityLabels: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? [])
    .describe("Traceable [labels] for any authority relied on. Must appear verbatim in the retrieval block."),
});

const ModelOutputSchema = z.object({
  responseType: SoftResponseType,
  responseTypeReason: z.string().describe("One sentence anchored to a case fact (finality, outstanding rejections)."),
  canDraftFromSources: SoftBool.describe(
    "True iff the retrieved sources contain the current claim text AND the office action. False → claimListing and remarks MUST be empty.",
  ),
  claimListing: z
    .array(ClaimEntry)
    .nullish()
    .transform((v) => v ?? [])
    .describe("COMPLETE listing of every claim, ascending, each with a status identifier — per 37 CFR 1.121(c)."),
  remarks: z
    .array(RemarkEntry)
    .nullish()
    .transform((v) => v ?? [])
    .describe("One entry per outstanding rejection."),
  openQuestions: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? [])
    .describe("Decisions the prosecutor must make before filing."),
});

export const DraftedAmendmentSchema = ModelOutputSchema.extend({
  // Derived after the model returns, so the model cannot assert them.
  unsupportedAmendmentCount: z.number().default(0),
  unverifiedAuthorityCount: z.number().default(0),
});
export type DraftedAmendment = z.infer<typeof DraftedAmendmentSchema>;

const AMENDMENT_SYSTEM = `You are a registered patent practitioner drafting a response to an outstanding office action. Output ONLY a JSON object matching the schema. No prose before or after.

Hard rules:
- The claim listing MUST include EVERY claim in the application, in ascending numerical order, each with a status identifier — 37 C.F.R. § 1.121(c). A listing containing only the amended claims is a non-compliant amendment.
- Status identifiers are exactly: ORIGINAL, CURRENTLY_AMENDED, PREVIOUSLY_PRESENTED, CANCELED, WITHDRAWN, NEW.
- Mark every insertion with <u>...</u> and every deletion with <s>...</s>. An amended claim with no markup is unusable.
- NEW MATTER IS PROHIBITED (35 U.S.C. § 132(a)). Every word you add to a claim must find support in the application as filed. Put that support in supportCitation, quoting the retrieved source. If you cannot point to support, do not make the amendment — narrow differently, or say so in openQuestions.
- Amend to overcome the specific limitations the analysis found NOT DISCLOSED. Do not amend limitations that were already found disclosed; that surrenders scope for nothing.
- Only cite authority whose [label] appears verbatim in the retrieved sources.
- If the current claim text or the office action is not in the retrieved sources, set canDraftFromSources=false and return empty claimListing and remarks. Do not reconstruct claims from memory.

Tone: this is a filing, not a memo. Write the remarks as they would be read by the examiner.`;

/** Drop authority labels that do not trace to retrieval; count what was dropped. */
function verifyAuthorities(
  out: z.infer<typeof ModelOutputSchema>,
  chunks: RetrievedChunk[],
): { remarks: z.infer<typeof RemarkEntry>[]; unverified: number } {
  const valid = new Set(chunks.map((c) => traceableLabel(c).toLowerCase()));
  let unverified = 0;
  const remarks = out.remarks.map((r) => {
    const kept = r.authorityLabels.filter((l) => {
      const bare = l.replace(/^\[|\]$/g, "").toLowerCase().trim();
      const ok = [...valid].some((v) => v.includes(bare) || bare.includes(v));
      if (!ok) unverified++;
      return ok;
    });
    return { ...r, authorityLabels: kept };
  });
  return { remarks, unverified };
}

/**
 * Count amendments that added language without citing written-description
 * support. This is the § 132(a) new-matter risk, and it is the single most
 * consequential thing to get wrong in an amendment -- so it is counted and
 * surfaced rather than left for the attorney to notice.
 */
function countUnsupported(entries: z.infer<typeof ClaimEntry>[]): number {
  return entries.filter((c) => /<u>/i.test(c.text) && !c.supportCitation.trim()).length;
}

export async function draftAmendment(
  analysis: RejectionAnalysis,
  caseSummary: string,
  chunks: RetrievedChunk[],
  opts: { maxAttempts?: number } = {},
): Promise<DraftedAmendment> {
  const maxAttempts = opts.maxAttempts ?? 2;

  const sourcesBlock = chunks
    .map((c) => `[${traceableLabel(c)}] (${c.origin})\n${c.text}`)
    .join("\n\n---\n\n");

  const failing = analysis.s102FailingLimitationIds.join(", ") || "(none)";
  const analysisBlock = [
    `§102 satisfied by the primary reference: ${analysis.s102Satisfied ? "YES" : "NO"}`,
    `Limitations found NOT disclosed: ${failing}`,
    `§103 sustainable on the record: ${analysis.s103Sustainable ? "YES" : "NO"}`,
    `Primary reference: ${analysis.primaryReference}`,
    analysis.secondaryReference ? `Secondary reference: ${analysis.secondaryReference}` : null,
    "",
    "Per-limitation findings:",
    ...analysis.limitations.map(
      (l) => `  ${l.id} [${l.disclosure}] ${l.text}${l.gap ? `\n      gap: ${l.gap}` : ""}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `Case summary:
${caseSummary}

Prior rejection analysis (authoritative — do not re-litigate these findings):
${analysisBlock}

Retrieved sources:
${sourcesBlock || "(none)"}

Draft the response. Amend to overcome the limitations listed as NOT disclosed, cite written-description support for every addition, and traverse each rejection in the remarks. Output the JSON object now.`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { object } = await generateObject({
        ...REASONING,
        schema: ModelOutputSchema,
        system: AMENDMENT_SYSTEM,
        prompt,
      });
      const { remarks, unverified } = verifyAuthorities(object, chunks);
      return {
        ...object,
        remarks,
        unverifiedAuthorityCount: unverified,
        unsupportedAmendmentCount: countUnsupported(object.claimListing),
      };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) console.warn(`[draft-amendment] attempt ${attempt} failed, retrying...`);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`draftAmendment failed after ${maxAttempts} attempts`);
}

const STATUS_LABEL: Record<z.infer<typeof StatusIdentifier>, string> = {
  ORIGINAL: "Original",
  CURRENTLY_AMENDED: "Currently Amended",
  PREVIOUSLY_PRESENTED: "Previously Presented",
  CANCELED: "Canceled",
  WITHDRAWN: "Withdrawn",
  NEW: "New",
};

/** Headers come from here, not the model, so the filing structure is guaranteed. */
export function renderAmendmentMarkdown(a: DraftedAmendment): string {
  const lines: string[] = [];

  if (!a.canDraftFromSources) {
    lines.push("**Draft skipped** — the retrieved sources do not contain both the current claim text and the office action.");
    lines.push("");
    lines.push(`Recommended response type: **${a.responseType.replace(/_/g, " ")}** — ${a.responseTypeReason}`);
    if (a.openQuestions.length > 0) {
      lines.push("", "**Open questions**", ...a.openQuestions.map((q) => `- ${q}`));
    }
    return lines.join("\n");
  }

  lines.push(`**Response type:** ${a.responseType.replace(/_/g, " ")} — ${a.responseTypeReason}`);
  lines.push("");

  if (a.unsupportedAmendmentCount > 0) {
    lines.push(
      `> ⚠️ ${a.unsupportedAmendmentCount} amended claim${a.unsupportedAmendmentCount === 1 ? "" : "s"} ` +
        `add${a.unsupportedAmendmentCount === 1 ? "s" : ""} language without a written-description citation. ` +
        `Confirm support in the application as filed before filing — unsupported additions are new matter under 35 U.S.C. § 132(a).`,
    );
    lines.push("");
  }

  lines.push("**AMENDMENTS TO THE CLAIMS**");
  lines.push("");
  lines.push(
    "This listing of claims replaces all prior versions and listings of claims in the application (37 C.F.R. § 1.121(c)).",
  );
  lines.push("");

  const sorted = [...a.claimListing].sort(
    (x, y) => (Number(x.claimNumber) || 0) - (Number(y.claimNumber) || 0),
  );
  for (const c of sorted) {
    lines.push(`**${c.claimNumber}. (${STATUS_LABEL[c.status]})** ${c.text}`.trim());
    if (c.changeSummary) lines.push(`  _Change:_ ${c.changeSummary}`);
    if (c.supportCitation) lines.push(`  _Support:_ ${c.supportCitation}`);
    lines.push("");
  }

  lines.push("**REMARKS**");
  lines.push("");
  if (a.remarks.length === 0) {
    lines.push("_(none generated)_");
  }
  for (const r of a.remarks) {
    lines.push(`**${r.rejectionAddressed}**`);
    lines.push("");
    lines.push(r.argument);
    if (r.authorityLabels.length > 0) {
      lines.push("");
      lines.push(`_Authorities:_ ${r.authorityLabels.join(", ")}`);
    }
    lines.push("");
  }

  if (a.unverifiedAuthorityCount > 0) {
    lines.push(
      `_${a.unverifiedAuthorityCount} cited authorit${a.unverifiedAuthorityCount === 1 ? "y was" : "ies were"} ` +
        `dropped: not traceable to the retrieved sources._`,
    );
    lines.push("");
  }

  if (a.openQuestions.length > 0) {
    lines.push("**OPEN QUESTIONS**");
    lines.push("");
    for (const q of a.openQuestions) lines.push(`- ${q}`);
  }

  return lines.join("\n").trim();
}
