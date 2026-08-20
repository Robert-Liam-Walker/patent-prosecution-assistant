// Eval harness for the structured predefined actions (draftNextMotion /
// getCaseStatus). Separate from eval_loop.ts so the
// rejection-analyzer eval can stay focused on that chain. Same recipe:
// programmatic rubric, deterministic checks, score + report.

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import {
  parseReportArgs,
  writeReport,
  printSplit,
  describeModels,
  type CheckKind,
  type ReportCard,
} from "./eval-report";

const CASE_WITH_REJECTION = "ea68b684-8f5b-4afa-b4e1-684b48b27707"; // claims2 + 2 prior arts + OA
const CASE_WITH_APP_NUM = "07d3d4e8-bfc7-42f9-a44a-8458795ba977"; // fake 17/123,456

// `kind` defaults to "capability" -- see scripts/eval-report.ts for what the
// split means and why only capability checks gate a phase.
type Check = { name: string; pass: boolean; detail?: string; kind?: CheckKind };
type Scorecard = ReportCard;

function finalize(id: string, checks: Check[]): Scorecard {
  const normalized = checks.map((c) => ({ ...c, kind: c.kind ?? ("capability" as CheckKind) }));
  const passCount = normalized.filter((c) => c.pass).length;
  return { id, checks: normalized, passCount, totalCount: normalized.length };
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
  // Substance check.
  //
  // This replaced a phrase blocklist that forbade "applicant respectfully
  // traverses" and similar. That blocklist was written against Llama 3.1 8B,
  // which emitted formal-sounding filler INSTEAD of argument, so the phrase was
  // used as a proxy for "is there real content here". Against a model that
  // writes like a practitioner the proxy inverts: those phrases are the correct
  // formal register for a response to an office action, and the check punished
  // the draft for being professionally worded (it went flaky at 2/3 runs in
  // phase 2b for exactly this reason).
  //
  // So test the thing the proxy stood for. A draft is substantive if it engages
  // specific claim limitations and names the reference it is arguing against --
  // which generic filler cannot do by construction. This is strictly harder to
  // pass than the blocklist was.
  const body = result.draftBody ?? "";
  // Limitation identifiers as they appear in these claims: (a), (b)(i), (e)...
  const citesLimitation = /\([a-z]\)(\s*\((?:i|ii|iii|iv|v)\))?/i.test(body);
  const namesReference = /(US\s*[\d,]{7,}|9,123,456|8,765,432|prior_art_us\d+)/i.test(body);
  const isSubstantive = body.length > 300;
  const substanceProblems = [
    citesLimitation ? null : "cites no claim limitation identifier",
    namesReference ? null : "names no prior-art reference",
    isSubstantive ? null : `too short (${body.length} chars)`,
  ].filter(Boolean) as string[];
  checks.push({
    name: "draft body engages specific limitations and references",
    pass: substanceProblems.length === 0,
    detail: substanceProblems.length > 0 ? substanceProblems.join("; ") : undefined,
  });
  return finalize("draftNextMotion", checks);
}

async function evalDraftAmendment(): Promise<Scorecard> {
  const checks: Check[] = [];
  const { analyzeRejection } = await import("../src/lib/analyze-rejection");
  const { draftAmendment, renderAmendmentMarkdown } = await import("../src/lib/draft-amendment");

  const { summary, chunks } = await loadCaseChunksAndSummary(
    CASE_WITH_REJECTION,
    "office action rejection claims amendment 37 CFR 1.121 manner of making amendments prior art",
  );

  const analysis = await analyzeRejection(
    "Analyze the outstanding rejection for the purpose of drafting a response.",
    chunks,
  );

  let result: Awaited<ReturnType<typeof draftAmendment>>;
  try {
    result = await draftAmendment(analysis, summary, chunks);
    checks.push({ name: "generateObject succeeds", pass: true });
  } catch (e) {
    checks.push({ name: "generateObject succeeds", pass: false, detail: String(e) });
    return finalize("draftAmendment", checks);
  }

  const md = renderAmendmentMarkdown(result);
  checks.push({ name: "render produces non-empty markdown", pass: md.length > 200, detail: `len=${md.length}` });

  const VALID_RESPONSE = ["AMENDMENT_AND_REMARKS", "REMARKS_ONLY", "RCE_WITH_AMENDMENT", "AFTER_FINAL_AMENDMENT", "OTHER"];
  checks.push({
    name: "responseType is a sanctioned enum value",
    pass: VALID_RESPONSE.includes(result.responseType),
    detail: result.responseType,
  });

  checks.push({
    name: "canDraftFromSources=true given an OA and claims are in the record",
    pass: result.canDraftFromSources === true,
    detail: `canDraftFromSources=${result.canDraftFromSources}`,
  });

  // 37 CFR 1.121(c): the listing must contain every claim, not only amended
  // ones, each with a status identifier, in ascending order.
  const nums = result.claimListing.map((c) => Number(c.claimNumber)).filter((n) => !Number.isNaN(n));
  checks.push({
    name: "claim listing is non-empty and includes claim 1",
    pass: nums.includes(1),
    detail: `claims=[${nums.join(",")}]`,
  });
  checks.push({
    name: "claim listing is in ascending order (37 CFR 1.121(c))",
    pass: nums.every((n, i) => i === 0 || n > nums[i - 1]),
    detail: `order=[${nums.join(",")}]`,
  });

  const VALID_STATUS = ["ORIGINAL", "CURRENTLY_AMENDED", "PREVIOUSLY_PRESENTED", "CANCELED", "WITHDRAWN", "NEW"];
  const badStatus = result.claimListing.filter((c) => !VALID_STATUS.includes(c.status)).map((c) => c.claimNumber);
  checks.push({
    name: "every claim carries a valid 1.121(c) status identifier",
    pass: badStatus.length === 0,
    detail: badStatus.length ? `bad on claims ${badStatus.join(",")}` : undefined,
  });

  // An amended claim with no markup cannot be filed -- the examiner cannot see
  // what changed.
  const amended = result.claimListing.filter((c) => c.status === "CURRENTLY_AMENDED");
  checks.push({
    name: "amended claims carry <u>/<s> change markup",
    pass: amended.length === 0 || amended.every((c) => /<u>|<s>/i.test(c.text)),
    detail: `amended=${amended.length}, marked=${amended.filter((c) => /<u>|<s>/i.test(c.text)).length}`,
  });

  // The §132(a) new-matter check: added language must cite written-description
  // support. This is the single most consequential defect an amendment can have.
  checks.push({
    name: "no added claim language without written-description support (§132(a))",
    pass: result.unsupportedAmendmentCount === 0,
    detail: `unsupported=${result.unsupportedAmendmentCount}`,
  });

  checks.push({
    name: "remarks address at least one rejection",
    pass: result.remarks.length > 0,
    detail: `remarks=${result.remarks.length}`,
  });

  const substantive = result.remarks.every((r) => r.argument.length > 150);
  checks.push({
    name: "each remark is substantive (>150 chars)",
    pass: result.remarks.length === 0 || substantive,
    detail: result.remarks.map((r) => r.argument.length).join(","),
  });

  checks.push({
    name: "no untraceable authorities survive verification",
    pass: result.unverifiedAuthorityCount === 0,
    detail: `dropped=${result.unverifiedAuthorityCount}`,
  });

  return finalize("draftAmendment", checks);
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
    ["draftNextMotion", evalDraftNextMotion],
    ["draftAmendment", evalDraftAmendment],
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

  printSplit(cards);
  const { jsonPath, label } = parseReportArgs(process.argv);
  const { model, embedModel } = await describeModels();
  await writeReport("eval_actions", cards, { jsonPath, label, model, embedModel });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
