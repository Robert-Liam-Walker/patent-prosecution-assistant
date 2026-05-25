// Eval harness for the structured predefined actions (predictNextAction
// / draftNextMotion / getCaseStatus). Separate from eval_loop.ts so the
// rejection-analyzer eval can stay focused on that chain. Same recipe:
// programmatic rubric, deterministic checks, score + report.

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const CASE_WITH_REJECTION = "ea68b684-8f5b-4afa-b4e1-684b48b27707"; // claims2 + 2 prior arts + OA
const CASE_WITH_APP_NUM = "07d3d4e8-bfc7-42f9-a44a-8458795ba977"; // fake 17/123,456

type Check = { name: string; pass: boolean; detail?: string };
type Scorecard = { id: string; checks: Check[]; passCount: number; totalCount: number };

function finalize(id: string, checks: Check[]): Scorecard {
  const passCount = checks.filter((c) => c.pass).length;
  return { id, checks, passCount, totalCount: checks.length };
}

function printCard(card: Scorecard) {
  const pct = card.totalCount > 0 ? Math.round((card.passCount / card.totalCount) * 100) : 0;
  console.log(`\n━━━ ${card.id} — ${card.passCount}/${card.totalCount} (${pct}%) ━━━`);
  for (const c of card.checks) {
    const mark = c.pass ? "✓" : "✗";
    const line = `  ${mark} ${c.name}`;
    console.log(c.detail && !c.pass ? `${line}\n      ${c.detail}` : line);
  }
}

async function loadCaseChunksAndSummary(caseId: string, query: string) {
  const { retrieve } = await import("../src/lib/rag");
  const { db, schema } = await import("../src/lib/db");
  const { eq } = await import("drizzle-orm");

  const [c] = await db.select().from(schema.cases).where(eq(schema.cases.id, caseId)).limit(1);
  if (!c) throw new Error(`case ${caseId} not found`);
  const docs = await db.select({ filename: schema.caseDocs.filename })
    .from(schema.caseDocs).where(eq(schema.caseDocs.caseId, caseId));

  const summary = [
    `Case: ${c.name}`,
    c.applicationNumber ? `Application #: ${c.applicationNumber}` : null,
    `Uploaded docs (${docs.length}): ${docs.map((d) => d.filename).join(", ") || "(none)"}`,
  ].filter(Boolean).join("\n");

  const chunks = await retrieve(query, { caseId, kCase: 8, kGlobal: 6 });
  return { summary, chunks };
}

async function evalPredictNextAction(): Promise<Scorecard> {
  const checks: Check[] = [];
  const { predictNextAction, renderPredictedActionMarkdown } = await import("../src/lib/predict-action");

  const { summary, chunks } = await loadCaseChunksAndSummary(
    CASE_WITH_REJECTION,
    "office action history; rejections; examiner patterns; finality",
  );

  let result;
  try {
    result = await predictNextAction(summary, chunks);
    checks.push({ name: "generateObject succeeds", pass: true });
  } catch (e) {
    checks.push({ name: "generateObject succeeds", pass: false, detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return finalize("predictNextAction", checks);
  }

  const md = renderPredictedActionMarkdown(result);
  checks.push({ name: "render produces non-empty markdown", pass: md.trim().length > 50 });
  checks.push({
    name: "mostLikelyAction is a sanctioned enum value",
    pass: ["NON_FINAL_OA","FINAL_OA","NOTICE_OF_ALLOWANCE","NOTICE_OF_ABANDONMENT","ADVISORY_ACTION","EXAMINER_INTERVIEW","EXAMINER_AMENDMENT","REQUIREMENT_FOR_INFORMATION","RESTRICTION_REQUIREMENT","QUAYLE_ACTION","OTHER"].includes(result.mostLikelyAction),
    detail: `got "${result.mostLikelyAction}"`,
  });
  checks.push({
    name: "probability is LOW | MEDIUM | HIGH",
    pass: ["LOW","MEDIUM","HIGH"].includes(result.probability),
    detail: `got "${result.probability}"`,
  });
  checks.push({
    name: "reasoning is substantive (>40 chars)",
    pass: result.reasoning.trim().length > 40,
    detail: `len=${result.reasoning.length}`,
  });
  checks.push({
    name: "no fabricated examiner stats (examinerStatsUsed=false expected for this case)",
    pass: result.examinerStatsUsed === false,
    detail: `examinerStatsUsed=${result.examinerStatsUsed}`,
  });
  // Plausibility: ea68b684 has a §102/§103 OA. Next likely action is
  // FINAL_OA or NON_FINAL_OA (depending on whether OA is final).
  checks.push({
    name: "prediction is plausible for an active rejection case (any OA / advisory / interview / OTHER)",
    pass: ["NON_FINAL_OA","FINAL_OA","ADVISORY_ACTION","EXAMINER_INTERVIEW","NOTICE_OF_ALLOWANCE","OTHER"].includes(result.mostLikelyAction),
    detail: `got "${result.mostLikelyAction}"`,
  });
  checks.push({
    name: "at most 2 alternatives",
    pass: result.alternatives.length <= 2,
    detail: `len=${result.alternatives.length}`,
  });
  return finalize("predictNextAction", checks);
}

async function evalDraftNextMotion(): Promise<Scorecard> {
  const checks: Check[] = [];
  const { draftNextMotion, renderDraftedMotionMarkdown } = await import("../src/lib/draft-motion");

  const { summary, chunks } = await loadCaseChunksAndSummary(
    CASE_WITH_REJECTION,
    "outstanding rejections; next required filing; office action response",
  );

  let result;
  try {
    result = await draftNextMotion(summary, chunks);
    checks.push({ name: "generateObject succeeds", pass: true });
  } catch (e) {
    checks.push({ name: "generateObject succeeds", pass: false, detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return finalize("draftNextMotion", checks);
  }

  const md = renderDraftedMotionMarkdown(result);
  checks.push({ name: "render produces non-empty markdown", pass: md.trim().length > 50 });
  checks.push({
    name: "nextDocumentType is a sanctioned enum value",
    pass: ["RESPONSE_NON_FINAL_OA","RESPONSE_FINAL_OA","RCE_WITH_AMENDMENT","AMENDMENT_ONLY","APPEAL_BRIEF","PRE_APPEAL_BRIEF_CONFERENCE","INTERVIEW_REQUEST","RESPONSE_TO_RESTRICTION","RESPONSE_TO_QUAYLE","INFORMATION_DISCLOSURE_STATEMENT","PETITION","OTHER"].includes(result.nextDocumentType),
    detail: `got "${result.nextDocumentType}"`,
  });
  // Case has an OA on file → expect a response-type or RCE
  checks.push({
    name: "plausible doc type given an active §102/§103 rejection",
    pass: ["RESPONSE_NON_FINAL_OA","RESPONSE_FINAL_OA","RCE_WITH_AMENDMENT","AMENDMENT_ONLY","APPEAL_BRIEF","INTERVIEW_REQUEST"].includes(result.nextDocumentType),
    detail: `got "${result.nextDocumentType}"`,
  });
  checks.push({
    name: "reason for doc type is non-trivial",
    pass: result.nextDocumentTypeReason.trim().length > 20,
    detail: `len=${result.nextDocumentTypeReason.length}`,
  });
  checks.push({
    name: "canDraftFromSources is boolean",
    pass: typeof result.canDraftFromSources === "boolean",
  });
  if (result.canDraftFromSources) {
    checks.push({
      name: "when canDraftFromSources=true, draftBody is substantive (>100 chars)",
      pass: result.draftBody.trim().length > 100,
      detail: `len=${result.draftBody.length}`,
    });
  } else {
    checks.push({
      name: "when canDraftFromSources=false, draftBody is empty",
      pass: result.draftBody.trim().length === 0,
      detail: `len=${result.draftBody.length}`,
    });
  }
  // Authority verification: any authority that survived must trace back
  // to retrieval. (verifyAuthorities runs in draftNextMotion already; this
  // check confirms it's working.)
  const { traceableLabel } = await import("../src/lib/rag");
  const validLabels = new Set(chunks.map((c) => `[${traceableLabel(c)}]`.toLowerCase()));
  const badAuthorities = result.authoritiesCited
    .filter((a) => {
      const norm = a.label.toLowerCase().trim();
      return ![...validLabels].some((v) => norm.includes(v) || v.includes(norm));
    })
    .map((a) => a.label);
  checks.push({
    name: "all cited authorities trace to retrieval (verifyAuthorities)",
    pass: badAuthorities.length === 0,
    detail: badAuthorities.length > 0 ? badAuthorities.join(" | ") : undefined,
  });
  // Forbidden phrases
  const forbidden = /(applicant respectfully (submits|traverses)|it is respectfully submitted|rejection should be reconsidered)/i;
  checks.push({
    name: "draft body avoids stock boilerplate phrases",
    pass: !forbidden.test(result.draftBody),
    detail: forbidden.exec(result.draftBody)?.[0],
  });
  return finalize("draftNextMotion", checks);
}

async function evalCaseStatus(): Promise<Scorecard> {
  const checks: Check[] = [];
  const { getCaseStatus, renderCaseStatusMarkdown } = await import("../src/lib/case-status");
  const { db, schema } = await import("../src/lib/db");
  const { eq } = await import("drizzle-orm");
  const { getApplicationStatus } = await import("../src/lib/uspto");

  const [c] = await db.select().from(schema.cases).where(eq(schema.cases.id, CASE_WITH_APP_NUM)).limit(1);
  if (!c) {
    checks.push({ name: "test case exists", pass: false, detail: `case ${CASE_WITH_APP_NUM} missing` });
    return finalize("getCaseStatus", checks);
  }

  let usptoText = "(no application number on file)";
  if (c.applicationNumber) {
    try {
      const status = await getApplicationStatus(c.applicationNumber);
      usptoText = JSON.stringify(status, null, 2);
    } catch (e) {
      usptoText = `(USPTO ODP lookup failed: ${e instanceof Error ? e.message : String(e)})`;
    }
  }
  const docs = await db.select({ filename: schema.caseDocs.filename }).from(schema.caseDocs).where(eq(schema.caseDocs.caseId, CASE_WITH_APP_NUM));
  const summary = [
    `Case: ${c.name}`,
    c.applicationNumber ? `Application #: ${c.applicationNumber}` : null,
    `Uploaded docs (${docs.length}): ${docs.map((d) => d.filename).join(", ") || "(none)"}`,
  ].filter(Boolean).join("\n");

  let result;
  try {
    result = await getCaseStatus(usptoText, summary);
    checks.push({ name: "generateObject succeeds", pass: true });
  } catch (e) {
    checks.push({ name: "generateObject succeeds", pass: false, detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return finalize("getCaseStatus", checks);
  }

  const md = renderCaseStatusMarkdown(result);
  checks.push({ name: "render produces non-empty markdown", pass: md.trim().length > 50 });
  checks.push({
    name: "recommendedNextStep is non-empty",
    pass: result.recommendedNextStep.trim().length > 0,
  });
  // ODP lookup will fail for fake 17/123,456 → model should NOT
  // fabricate examiner/art unit/dates.
  const odpFailed = /USPTO ODP lookup failed/.test(usptoText) || /(no application number on file)/.test(usptoText);
  if (odpFailed) {
    checks.push({
      name: "ODP-fail case: examinerName empty (no fabrication)",
      pass: !result.examinerName,
      detail: `got "${result.examinerName}"`,
    });
    checks.push({
      name: "ODP-fail case: artUnit empty (no fabrication)",
      pass: !result.artUnit,
      detail: `got "${result.artUnit}"`,
    });
  }
  checks.push({
    name: "applicationNumber matches case record if provided",
    pass: !c.applicationNumber || !result.applicationNumber ||
      result.applicationNumber.replace(/[^0-9]/g, "") === c.applicationNumber.replace(/[^0-9]/g, ""),
    detail: `case="${c.applicationNumber}" model="${result.applicationNumber}"`,
  });
  return finalize("getCaseStatus", checks);
}

async function main() {
  const cards: Scorecard[] = [];
  for (const [name, fn] of [
    ["predictNextAction", evalPredictNextAction],
    ["draftNextMotion", evalDraftNextMotion],
    ["getCaseStatus", evalCaseStatus],
  ] as const) {
    console.log(`\n[eval-actions] running ${name}…`);
    try {
      const card = await fn();
      cards.push(card);
      printCard(card);
    } catch (e) {
      console.error(`[eval-actions] ${name} crashed:`, e);
    }
  }
  const totalPass = cards.reduce((s, c) => s + c.passCount, 0);
  const total = cards.reduce((s, c) => s + c.totalCount, 0);
  console.log(`\n━━━ AGGREGATE — ${totalPass}/${total} (${Math.round((totalPass / total) * 100)}%) ━━━`);
  console.log(`\nFAILING CHECKS:`);
  for (const card of cards) {
    for (const c of card.checks) {
      if (!c.pass) console.log(`  [${card.id}] ${c.name}${c.detail ? `  → ${c.detail}` : ""}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
