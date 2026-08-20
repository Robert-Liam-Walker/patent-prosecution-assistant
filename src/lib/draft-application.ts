// Structured patent-application drafter.
//
// Takes an invention disclosure and produces a full specification plus claims.
//
// THE GROUNDING EXCEPTION
// ----------------------
// Every other analyzer in this app runs under a hard rule: assert nothing that
// is not in the retrieved sources. Application drafting cannot work that way --
// the output is, by definition, prose that does not exist yet.
//
// The exception is narrower than it first looks. The disclosure IS in the
// record once uploaded, so factual grounding still holds completely: every
// technical fact must trace to it. What is newly permitted is composing the
// *form* -- section scaffolding, transitional phrasing, claim syntax.
//
// What is never permitted is inventing substance: an embodiment, an advantage,
// a numeric range, or a result the inventor did not disclose. Fabricated
// technical content in a specification is not a quality problem, it is a
// §112(a) written-description defect baked into the filing, and it is
// unfixable later because new matter cannot be added (35 U.S.C. §132(a)).
//
// Where the disclosure is silent, the model must emit an explicit
// [ATTORNEY INPUT NEEDED: ...] marker rather than filling the gap. Those
// markers are counted and surfaced -- an application that silently invented
// its way past a gap is far more dangerous than one that admits the gap.

import { generateObject } from "ai";
import { z } from "zod";
import { REASONING } from "@/lib/llm";
import { traceableLabel, type RetrievedChunk } from "@/lib/rag";
import { SECTION_KEYS, SECTION_TITLES, type SectionKey } from "@/lib/draft-sections";

export { SECTION_KEYS, SECTION_TITLES } from "@/lib/draft-sections";
export type { SectionKey } from "@/lib/draft-sections";

// Per-section drafting guidance. Kept out of the shared system prompt so each
// call carries only what it needs -- a section prompt describing all seven
// sections invites the model to draft all seven.
const SECTION_BRIEF: Record<SectionKey, string> = {
  title:
    "A short descriptive title, under 15 words, no marketing language, no trademarks. Return the title only.",
  technicalField:
    "One or two sentences stating the technical field. Conventionally opens 'The present disclosure relates to...'.",
  background:
    "State the problem and why existing approaches are inadequate, drawn ONLY from the disclosure. Do not characterise anything as 'prior art' and do not admit that any specific reference is prior art -- such admissions are binding against the applicant. Describe shortcomings neutrally.",
  summary:
    "Summarise the invention and its advantages. Track the language that will appear in the claims, since this section is where claim terms find written-description support. Do not use absolute characterisations like 'the invention must' or 'essential' -- they narrow claim scope during construction.",
  briefDescriptionOfDrawings:
    "One line per figure, 'FIG. N is a ...'. If the disclosure describes no figures, emit a single [ATTORNEY INPUT NEEDED: ...] line saying which figures the disclosure implies are needed. Do not invent figure contents.",
  detailedDescription:
    "The longest section. Describe the embodiment in enough detail to enable a person skilled in the art to make and use it (35 U.S.C. §112(a)). Use numbered paragraphs [0001], [0002], ... Refer to figure elements by reference numeral only if the disclosure supplies them. Cover the alternatives the disclosure lists -- alternatives left out cannot be claimed later. Where the disclosure lacks a detail needed for enablement, emit [ATTORNEY INPUT NEEDED: ...] inline.",
  abstract:
    "A single paragraph, 150 WORDS OR FEWER (37 C.F.R. §1.72(b)), describing the technical disclosure. No legal phrasing, no 'means', no reference numerals in parentheses.",
};

const SectionOutput = z.object({
  text: z.string().describe("The drafted section text. Markdown paragraphs. No section header -- the renderer adds it."),
  gapsFlagged: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? [])
    .describe("One entry per [ATTORNEY INPUT NEEDED] marker placed, describing what the disclosure lacks."),
  factsUsed: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? [])
    .describe("Short quotes or paraphrases from the disclosure this section relied on, for traceability."),
});

const ClaimEntry = z.object({
  number: z.number().describe("Claim number, starting at 1."),
  dependsOn: z
    .number()
    .nullish()
    .transform((v) => v ?? 0)
    .describe("Claim number this depends on; 0 for an independent claim."),
  text: z.string().describe("Full claim text WITHOUT the leading number. Independent claims use the preamble/transition/body structure."),
});

const ClaimSetOutput = z.object({
  claims: z.array(ClaimEntry).describe("Claim set, ascending. At least one independent claim."),
  gapsFlagged: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? [])
    .describe("Anything the disclosure did not support well enough to claim."),
});

const DRAFT_SYSTEM = `You are a registered patent practitioner drafting a US non-provisional patent application from an invention disclosure. Output ONLY a JSON object matching the schema. No prose before or after.

GROUNDING — this is the rule that matters most:
- Every TECHNICAL FACT must come from the invention disclosure. You are composing prose, not inventing subject matter.
- You may compose structure, transitions, and conventional patent phrasing freely.
- You may NOT invent an embodiment, an advantage, a numeric value, a range, a material, a measurement, or an experimental result that the disclosure does not contain.
- Where the disclosure is silent on something the section needs, write exactly: [ATTORNEY INPUT NEEDED: <what is missing and why it matters>] and continue. Do NOT fill the gap with a plausible guess. An admitted gap is recoverable; invented matter in a filed application is not, because new matter cannot be added later (35 U.S.C. §132(a)).

DRAFTING CONVENTIONS:
- Use "comprising" as the open transitional phrase unless the disclosure requires a closed set.
- Avoid "invention" where "embodiment" or "disclosure" will do; avoid "must", "essential", "critical", "always" — each narrows claim scope during construction.
- Do not admit prior art. Do not characterise any specific reference as prior art.
- Claim terms must have antecedent support in the specification: if a claim will say "a thermal coefficient", the specification must describe one.`;

export type DraftedSection = z.infer<typeof SectionOutput> & { key: SectionKey };
export type DraftedClaims = z.infer<typeof ClaimSetOutput> & { antecedentProblems: string[] };

export type DraftedApplication = {
  sections: DraftedSection[];
  claims: DraftedClaims;
  totalGaps: number;
  abstractWordCount: number;
};

function disclosureBlock(disclosure: string, chunks: RetrievedChunk[]): string {
  const support = chunks.length
    ? `\n\nSupporting retrieved sources (for terminology and statutory context only -- NOT a source of technical facts about this invention):\n${chunks
        .map((c) => `[${traceableLabel(c)}]\n${c.text}`)
        .join("\n\n---\n\n")}`
    : "";
  return `INVENTION DISCLOSURE (the sole source of technical facts):\n${disclosure}${support}`;
}

/** Draft or re-draft a single section. Exported so the UI can regenerate one section. */
export async function draftSection(
  key: SectionKey,
  disclosure: string,
  chunks: RetrievedChunk[],
  priorSections: DraftedSection[] = [],
  opts: { maxAttempts?: number } = {},
): Promise<DraftedSection> {
  const maxAttempts = opts.maxAttempts ?? 2;

  // Later sections see earlier ones so terminology stays consistent -- a
  // specification that calls the same component two different names creates
  // antecedent-basis problems in prosecution.
  const priorBlock = priorSections.length
    ? `\n\nSections already drafted (match their terminology exactly):\n${priorSections
        .map((s) => `## ${SECTION_TITLES[s.key]}\n${s.text}`)
        .join("\n\n")}`
    : "";

  const prompt = `${disclosureBlock(disclosure, chunks)}${priorBlock}

Draft the ${SECTION_TITLES[key]} section.

${SECTION_BRIEF[key]}

Output the JSON object now.`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { object } = await generateObject({
        ...REASONING,
        schema: SectionOutput,
        system: DRAFT_SYSTEM,
        prompt,
      });
      return { ...object, key };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) console.warn(`[draft-application] ${key} attempt ${attempt} failed, retrying...`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`draftSection(${key}) failed`);
}

/**
 * Words that end a noun phrase. Without these the capture runs across clause
 * boundaries and produces non-terms like "the first die while continuing",
 * which is how the first version of this check managed to raise 39 flags on a
 * 27-claim set. A checker that is wrong that often gets ignored, so it is worth
 * being conservative: prefer missing a real defect to burying it in noise.
 */
const PHRASE_STOP = new Set([
  "while", "and", "or", "but", "based", "from", "to", "into", "for", "of", "on",
  "in", "at", "by", "with", "that", "which", "is", "are", "was", "were", "be",
  "being", "been", "comprising", "configured", "wherein", "when", "if", "as",
  "having", "including", "such", "each", "said", "then", "than", "thereby",
  "whereby", "according", "corresponding", "associated", "maintained",
  "addressed", "stored", "generated", "determined", "received", "continuing",
  "exceeds", "exceeding", "causes", "causing", "during", "receives", "receiving",
  "no", "not", "more", "less", "least", "most", "same", "only", "further",
]);

/**
 * Extract noun phrases following an article.
 *
 * Tokenised rather than regex-scanned on purpose. Any regex that captures the
 * words after "a" advances `lastIndex` past them, so a later article inside the
 * captured span is never seen: "a controller for a stacked package comprising a
 * plurality of dies" yields only "controller", losing the other two. Those lost
 * introductions then surface as bogus missing-antecedent flags on every
 * dependent claim. Walking the token stream sees every article exactly once.
 *
 * Both the "a/an" (introduction) and "the" (reference) scans use this, so a
 * term introduced one way is recognised the other way.
 */
function nounPhrasesAfter(text: string, article: "indefinite" | "definite"): Set<string> {
  const want = article === "indefinite" ? new Set(["a", "an"]) : new Set(["the"]);
  const tokens = text.toLowerCase().split(/[\s]+/).map((t) => t.replace(/[^a-z-]/g, ""));
  const out = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    if (!want.has(tokens[i])) continue;
    const words: string[] = [];
    for (let j = i + 1; j < tokens.length && words.length < 3; j++) {
      const w = tokens[j];
      if (!w || PHRASE_STOP.has(w) || w === "a" || w === "an" || w === "the") break;
      words.push(w);
    }
    if (words.length > 0) out.add(words.join(" "));
  }
  return out;
}

/** True if `term` matches any introduced phrase, allowing head-noun overlap. */
function hasAntecedent(term: string, introduced: Set<string>): boolean {
  if (introduced.has(term)) return true;
  const head = term.split(" ").slice(-1)[0];
  for (const i of introduced) {
    if (i === term) return true;
    // "the relevance score" vs "a relevance score for each document"
    if (i.startsWith(term) || term.startsWith(i)) return true;
    // Head-noun match: "the coefficients" vs "a set of coupling coefficients"
    if (i.split(" ").includes(head)) return true;
    // Singular/plural tolerance
    if (i.replace(/s$/, "") === term.replace(/s$/, "")) return true;
  }
  return false;
}

/**
 * Check every dependent claim references a lower-numbered claim, and that each
 * "the X" has a matching "a X" earlier in the same claim chain. Antecedent-basis
 * defects draw §112(b) rejections and are mechanical to catch, so there is no
 * reason to leave them to the model.
 */
// Exported so it can be tested directly against real generated claims.
export function checkAntecedents(claims: { number: number; dependsOn: number; text: string }[]): string[] {
  const problems: string[] = [];
  const byNumber = new Map(claims.map((c) => [c.number, c]));

  // Terms so conventional they never need an explicit antecedent.
  const CONVENTIONAL =
    /^(present|disclosure|invention|embodiment|embodiments|art|same|method|methods|steps?|group|plurality|claim|claims|first|second|third|fourth|one|two|three|four|other|others|above|below|following|preceding|respective|field|art)$/;

  for (const c of claims) {
    if (c.dependsOn) {
      if (c.dependsOn >= c.number) {
        problems.push(`Claim ${c.number} depends on claim ${c.dependsOn} — a dependent claim must reference a lower-numbered claim.`);
        continue;
      }
      if (!byNumber.has(c.dependsOn)) {
        problems.push(`Claim ${c.number} depends on claim ${c.dependsOn}, which does not exist.`);
        continue;
      }
    }

    // Walk the dependency chain and collect everything introduced along it.
    const introduced = new Set<string>();
    let cur: z.infer<typeof ClaimEntry> | undefined = c;
    const guard = new Set<number>();
    const chain: z.infer<typeof ClaimEntry>[] = [];
    while (cur && !guard.has(cur.number)) {
      guard.add(cur.number);
      chain.unshift(cur);
      cur = cur.dependsOn ? byNumber.get(cur.dependsOn) : undefined;
    }
    for (const link of chain) {
      for (const t of nounPhrasesAfter(link.text, "indefinite")) introduced.add(t);
    }

    const seen = new Set<string>();
    for (const term of nounPhrasesAfter(c.text, "definite")) {
      if (seen.has(term)) continue;
      seen.add(term);
      if (CONVENTIONAL.test(term.split(" ")[0])) continue;
      if (!hasAntecedent(term, introduced)) {
        problems.push(`Claim ${c.number}: "the ${term}" may lack antecedent basis (§112(b)).`);
      }
    }
  }
  return problems;
}

export async function draftClaims(
  disclosure: string,
  chunks: RetrievedChunk[],
  sections: DraftedSection[],
  opts: { maxAttempts?: number } = {},
): Promise<DraftedClaims> {
  const maxAttempts = opts.maxAttempts ?? 2;

  const specBlock = sections.map((s) => `## ${SECTION_TITLES[s.key]}\n${s.text}`).join("\n\n");

  const prompt = `${disclosureBlock(disclosure, chunks)}

Specification drafted so far (claim terms MUST have support here):
${specBlock}

Draft the claim set.

- At least one independent claim. Add independent claims in other statutory classes (system, computer-readable medium) only where the disclosure supports them.
- Independent claims: preamble, transitional phrase ("comprising"), then the body in indented elements.
- Dependent claims must narrow, must reference exactly one lower-numbered claim, and must not repeat limitations already present in the parent.
- Every "the X" must have an earlier "a X" in the same claim or its parent — antecedent basis under §112(b).
- Claim the alternatives the disclosure describes. An alternative not claimed and not described is lost.
- Do NOT claim subject matter the disclosure does not support; flag it in gapsFlagged instead.

Output the JSON object now.`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { object } = await generateObject({
        ...REASONING,
        schema: ClaimSetOutput,
        system: DRAFT_SYSTEM,
        prompt,
      });
      const sorted = [...object.claims].sort((a, b) => a.number - b.number);
      return { ...object, claims: sorted, antecedentProblems: checkAntecedents(sorted) };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) console.warn(`[draft-application] claims attempt ${attempt} failed, retrying...`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("draftClaims failed");
}

/** Draft the whole application, section by section, then the claims. */
export async function draftApplication(
  disclosure: string,
  chunks: RetrievedChunk[],
): Promise<DraftedApplication> {
  const sections: DraftedSection[] = [];
  for (const key of SECTION_KEYS) {
    sections.push(await draftSection(key, disclosure, chunks, sections));
  }
  const claims = await draftClaims(disclosure, chunks, sections);

  const abstract = sections.find((s) => s.key === "abstract");
  const abstractWordCount = abstract ? abstract.text.trim().split(/\s+/).filter(Boolean).length : 0;

  return {
    sections,
    claims,
    totalGaps: sections.reduce((n, s) => n + s.gapsFlagged.length, 0) + claims.gapsFlagged.length,
    abstractWordCount,
  };
}

/** Headers come from here so the statutory section order is guaranteed. */
export function renderApplicationMarkdown(a: DraftedApplication): string {
  const lines: string[] = [];

  if (a.totalGaps > 0) {
    lines.push(
      `> ⚠️ ${a.totalGaps} point${a.totalGaps === 1 ? "" : "s"} in this draft are marked ` +
        `[ATTORNEY INPUT NEEDED] — the disclosure did not supply them. Resolve every one before filing: ` +
        `material added after filing is new matter and cannot be entered (35 U.S.C. § 132(a)).`,
    );
    lines.push("");
  }
  if (a.abstractWordCount > 150) {
    lines.push(`> ⚠️ Abstract is ${a.abstractWordCount} words; 37 C.F.R. § 1.72(b) caps it at 150.`);
    lines.push("");
  }
  if (a.claims.antecedentProblems.length > 0) {
    lines.push(`> ⚠️ ${a.claims.antecedentProblems.length} possible antecedent-basis issue(s) — see the end of this draft.`);
    lines.push("");
  }

  for (const s of a.sections) {
    if (s.key === "abstract") continue; // abstract goes last, per convention
    lines.push(`## ${SECTION_TITLES[s.key]}`);
    lines.push("");
    lines.push(s.text.trim());
    lines.push("");
  }

  lines.push("## CLAIMS");
  lines.push("");
  lines.push("What is claimed is:");
  lines.push("");
  for (const c of a.claims.claims) {
    lines.push(`${c.number}. ${c.text.trim()}`);
    lines.push("");
  }

  const abstract = a.sections.find((s) => s.key === "abstract");
  if (abstract) {
    lines.push("## ABSTRACT");
    lines.push("");
    lines.push(abstract.text.trim());
    lines.push("");
    lines.push(`_(${a.abstractWordCount} words)_`);
    lines.push("");
  }

  if (a.claims.antecedentProblems.length > 0) {
    lines.push("## ANTECEDENT-BASIS REVIEW");
    lines.push("");
    lines.push("Mechanically detected; confirm each before filing:");
    lines.push("");
    for (const p of a.claims.antecedentProblems) lines.push(`- ${p}`);
    lines.push("");
  }

  const allGaps = [...a.sections.flatMap((s) => s.gapsFlagged), ...a.claims.gapsFlagged];
  if (allGaps.length > 0) {
    lines.push("## ATTORNEY INPUT NEEDED");
    lines.push("");
    for (const g of allGaps) lines.push(`- ${g}`);
  }

  return lines.join("\n").trim();
}
