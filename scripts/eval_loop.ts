// Programmatic eval harness for the structured rejection analyzer.
// Runs the analyzer against a set of test queries, scores each output
// against a deterministic rubric, prints a scorecard. Used by the
// autonomous improvement loop — between runs, the agent reads the
// scorecard, picks the top failing check, and applies a targeted fix
// to analyze-rejection.ts / prompts.ts / chat route.

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const CASE_ID = "ea68b684-8f5b-4afa-b4e1-684b48b27707";

type TestCase = {
  id: string;
  query: string;
  expect: {
    s102SatisfiedTruth?: boolean;
    requiredFailingLimitations?: string[];
    requiredPartialOrFailing?: string[];
    expectStructured: boolean;
  };
};

const TESTS: TestCase[] = [
  {
    id: "primary-102-103",
    query:
      "I received a rejection where the examiner cites US 9,123,456 alone for §102 and alternatively combines US 9,123,456 with US 8,765,432 under §103. Break down which claim elements are fully anticipated vs only partially disclosed. Then explain whether this is a proper §102 rejection or should be §103 instead.",
    expect: {
      // Ground truth (per ChatGPT review of 4d output):
      //   - (b)(ii) "recency within case file" — primary only has "modification recency",
      //     different scope → NOT_DISCLOSED or PARTIALLY
      //   - (b)(iii) "citation frequency in legal corpus" — primary has "frequency of access",
      //     different metric → NOT_DISCLOSED or PARTIALLY (only US 8,765,432 has it)
      //   - (b)(i) "semantic similarity user-query/content" — primary has "vector similarity",
      //     arguable → SHOULD BE PARTIALLY, not NOT_DISCLOSED (4d was over-strict here)
      //   - (e) wherein "recalc after each event" — primary has "updated when interactions
      //     occur", more general → SHOULD BE PARTIALLY, not DISCLOSED (4d was under-strict)
      s102SatisfiedTruth: false,
      requiredFailingLimitations: ["(b)(ii)", "(b)(iii)"],
      requiredPartialOrFailing: ["(b)(i)", "(e)"],
      expectStructured: true,
    },
  },
  {
    id: "general-question",
    query: "What is the difference between §102 and §103?",
    expect: {
      // Not a case-specific rejection analysis — should NOT trigger
      // structured mode. Falls through to freeform chat.
      expectStructured: false,
    },
  },
];

type Check = {
  name: string;
  pass: boolean;
  detail?: string;
};

type Scorecard = {
  testId: string;
  routed: "structured" | "freeform" | "error";
  checks: Check[];
  passCount: number;
  totalCount: number;
};

// Banned terms = LEGAL-INCOHERENT phrases that previous iterations
// surfaced. "PARTIALLY_DISCLOSED" (schema label) and "Partially disclosed
// (arguable):" (renderer detail) are now LEGITIMATE — they describe a
// limitation-level state that still kills §102 in the binary verdict.
// We only catch the gradient-applied-to-verdict phrases.
const BANNED_TERMS = [
  /\bfully\s+anticipat(?:ed|ion)\b/i,
  /\bpartial(?:ly)?\s+anticipat(?:ed|ion)\b/i,
  /\bpartial\s+§\s*102\b/i,
  /\bessentially\s+disclosed\b/i,
];

function normalizeForSubstring(s: string): string {
  return s.toLowerCase().replace(/[\s ]+/g, " ").replace(/[–—−-]/g, "-").trim();
}

function substringIn(needle: string, haystacks: string[]): boolean {
  if (!needle) return true;
  const n = normalizeForSubstring(needle);
  if (n.length < 6) return true; // very short strings are noise
  return haystacks.some((h) => normalizeForSubstring(h).includes(n));
}

async function scoreStructured(
  testId: string,
  query: string,
  expect: TestCase["expect"],
): Promise<Scorecard> {
  const { retrieve } = await import("../src/lib/rag");
  const { analyzeRejection, isRejectionAnalysisQuery, renderAnalysisMarkdown } =
    await import("../src/lib/analyze-rejection");

  const chunks = await retrieve(query, { caseId: CASE_ID, kCase: 8, kGlobal: 6 });
  const routed = isRejectionAnalysisQuery(query, chunks) ? "structured" : "freeform";

  const checks: Check[] = [];

  checks.push({
    name: "routing matches expectation",
    pass: (routed === "structured") === expect.expectStructured,
    detail: `routed=${routed}, expected=${expect.expectStructured ? "structured" : "freeform"}`,
  });

  if (!expect.expectStructured) {
    return finalize(testId, routed, checks);
  }
  if (routed !== "structured") {
    return finalize(testId, routed, checks);
  }

  let analysis;
  try {
    analysis = await analyzeRejection(query, chunks);
  } catch (e) {
    checks.push({
      name: "generateObject succeeds",
      pass: false,
      detail: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
    return finalize(testId, "error", checks);
  }
  checks.push({ name: "generateObject succeeds", pass: true });

  const md = renderAnalysisMarkdown(analysis);

  // Structural checks
  for (const header of [
    "(A) CLAIM BREAKDOWN",
    "(B) PRIOR ART MAPPING",
    "(C) §102 VERDICT",
    "(D) §103 ANALYSIS",
    "(E) CONCLUSION",
  ]) {
    checks.push({
      name: `header present: ${header}`,
      pass: md.includes(header),
    });
  }

  // Banned-term checks (in rendered markdown — covers labels, gaps, conclusion)
  for (const pat of BANNED_TERMS) {
    const m = md.match(pat);
    checks.push({
      name: `no banned term: ${pat.source}`,
      pass: !m,
      detail: m ? `matched "${m[0]}"` : undefined,
    });
  }

  // Disclosure label compliance — three valid labels now
  const VALID_LABELS = ["DISCLOSED", "PARTIALLY_DISCLOSED", "NOT_DISCLOSED"];
  const badLabels = analysis.limitations
    .filter((l) => !VALID_LABELS.includes(l.disclosure))
    .map((l) => `${l.id}=${l.disclosure}`);
  checks.push({
    name: "all disclosure labels are DISCLOSED|PARTIALLY_DISCLOSED|NOT_DISCLOSED",
    pass: badLabels.length === 0,
    detail: badLabels.length > 0 ? badLabels.join(", ") : undefined,
  });

  // §102 consistency: SATISFIED iff every limitation is DISCLOSED.
  // PARTIALLY_DISCLOSED kills §102 (it's a verdict-level failure, even
  // if it's an arguable prosecutor point at the limitation level).
  const allDisclosed = analysis.limitations.every((l) => l.disclosure === "DISCLOSED");
  checks.push({
    name: "s102Satisfied matches limitation labels (binary verdict over 3-tier labels)",
    pass: analysis.s102Satisfied === allDisclosed,
    detail: `s102Satisfied=${analysis.s102Satisfied}, allDisclosed=${allDisclosed}`,
  });

  // failing-limitation list consistency: PARTIALLY + NOT_DISCLOSED both count
  const actualFailing = analysis.limitations
    .filter((l) => l.disclosure !== "DISCLOSED")
    .map((l) => l.id)
    .sort();
  const claimedFailing = [...analysis.s102FailingLimitationIds].sort();
  checks.push({
    name: "s102FailingLimitationIds includes all non-DISCLOSED limitations",
    pass: JSON.stringify(actualFailing) === JSON.stringify(claimedFailing),
    detail: `actual=[${actualFailing.join(",")}] claimed=[${claimedFailing.join(",")}]`,
  });

  // §103 reference contributions present when §103 is the focus
  const hasSecondary =
    Boolean(analysis.secondaryReference) &&
    analysis.secondaryReference.toLowerCase() !== "none";
  if (hasSecondary && !analysis.s102Satisfied) {
    checks.push({
      name: "§103 has at least one reference contribution when secondary cited and §102 fails",
      pass: analysis.s103ReferenceContributions.length > 0,
      detail: analysis.s103ReferenceContributions.length === 0
        ? "model omitted referenceContributions for §103 analysis"
        : undefined,
    });
  }

  // Verbatim check: claimText must appear in a retrieved case chunk
  const caseTexts = chunks.filter((c) => c.origin === "case").map((c) => c.text);
  checks.push({
    name: "claimText quoted verbatim from retrieved case docs",
    pass: substringIn(analysis.claimText, caseTexts),
    detail: substringIn(analysis.claimText, caseTexts) ? undefined : `quoted text not found in case chunks`,
  });

  // Verbatim check: each evidence quote must appear in a retrieved chunk.
  // Skip the auto-downgrade sentinels (they're a feature of the analyzer,
  // not a model failure).
  const allTexts = chunks.map((c) => c.text);
  const evidenceProblems: string[] = [];
  const sentinels = [
    /no related text/i,
    /evidence not verifiable in retrieved sources/i,
    /not in primary/i,
  ];
  for (const lim of analysis.limitations) {
    if (!lim.evidence) continue;
    if (sentinels.some((re) => re.test(lim.evidence))) continue;
    if (!substringIn(lim.evidence, allTexts)) {
      evidenceProblems.push(`${lim.id}: "${lim.evidence.slice(0, 60)}..."`);
    }
  }
  checks.push({
    name: "all evidence quotes appear verbatim in retrieved chunks",
    pass: evidenceProblems.length === 0,
    detail: evidenceProblems.length > 0 ? evidenceProblems.slice(0, 3).join(" | ") : undefined,
  });

  // §103 legal logic: if §102 not satisfied and no motivation in record, sustainable should be false
  const expectedSustainable = !(!analysis.s102Satisfied && !analysis.s103MotivationInRecord);
  const logicConsistent = expectedSustainable || !analysis.s103Sustainable;
  checks.push({
    name: "s103Sustainable=false when §102 fails AND no motivation in record",
    pass: logicConsistent,
    detail: `s102Satisfied=${analysis.s102Satisfied} s103MotivationInRecord=${analysis.s103MotivationInRecord} s103Sustainable=${analysis.s103Sustainable}`,
  });

  // Ground-truth check: s102Satisfied should match expectation
  if (expect.s102SatisfiedTruth !== undefined) {
    checks.push({
      name: `ground truth: s102Satisfied == ${expect.s102SatisfiedTruth}`,
      pass: analysis.s102Satisfied === expect.s102SatisfiedTruth,
      detail: `got ${analysis.s102Satisfied}`,
    });
  }
  if (expect.requiredFailingLimitations && expect.requiredFailingLimitations.length > 0) {
    const hits = expect.requiredFailingLimitations.filter((id) =>
      analysis.s102FailingLimitationIds.includes(id) ||
      analysis.limitations.some((l) => l.id === id && l.disclosure !== "DISCLOSED"),
    );
    checks.push({
      name: `ground truth: at least one of [${expect.requiredFailingLimitations.join("|")}] is non-DISCLOSED`,
      pass: hits.length > 0,
      detail: hits.length === 0 ? `model said all disclosed (failing: [${analysis.s102FailingLimitationIds.join(",")}])` : undefined,
    });
  }
  if (expect.requiredPartialOrFailing && expect.requiredPartialOrFailing.length > 0) {
    const hits = expect.requiredPartialOrFailing.filter((id) =>
      analysis.limitations.some((l) => l.id === id && l.disclosure !== "DISCLOSED"),
    );
    checks.push({
      name: `ground truth: [${expect.requiredPartialOrFailing.join(",")}] should be PARTIALLY or NOT_DISCLOSED (over/under-strict guard)`,
      pass: hits.length === expect.requiredPartialOrFailing.length,
      detail: hits.length < expect.requiredPartialOrFailing.length
        ? `missing: ${expect.requiredPartialOrFailing.filter((id) => !hits.includes(id)).join(",")}`
        : undefined,
    });
  }

  return finalize(testId, routed, checks);
}

function finalize(testId: string, routed: Scorecard["routed"], checks: Check[]): Scorecard {
  const passCount = checks.filter((c) => c.pass).length;
  return { testId, routed, checks, passCount, totalCount: checks.length };
}

function printCard(card: Scorecard) {
  const pct = card.totalCount > 0 ? Math.round((card.passCount / card.totalCount) * 100) : 0;
  console.log(`\n━━━ ${card.testId} (routed=${card.routed}) — ${card.passCount}/${card.totalCount} (${pct}%) ━━━`);
  for (const c of card.checks) {
    const mark = c.pass ? "✓" : "✗";
    const line = `  ${mark} ${c.name}`;
    console.log(c.detail && !c.pass ? `${line}\n      ${c.detail}` : line);
  }
}

async function main() {
  const cards: Scorecard[] = [];
  for (const t of TESTS) {
    console.log(`\n[eval] running ${t.id}…`);
    const card = await scoreStructured(t.id, t.query, t.expect);
    cards.push(card);
    printCard(card);
  }

  const totalPass = cards.reduce((s, c) => s + c.passCount, 0);
  const total = cards.reduce((s, c) => s + c.totalCount, 0);
  console.log(`\n━━━ AGGREGATE — ${totalPass}/${total} (${Math.round((totalPass / total) * 100)}%) ━━━`);
  console.log(`\nFAILING CHECKS:`);
  for (const card of cards) {
    for (const c of card.checks) {
      if (!c.pass) console.log(`  [${card.testId}] ${c.name}${c.detail ? `  → ${c.detail}` : ""}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
