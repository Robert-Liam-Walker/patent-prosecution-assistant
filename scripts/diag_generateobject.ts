import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const CASE_ID = "ea68b684-8f5b-4afa-b4e1-684b48b27707";
const QUERY = "I received a rejection where the examiner cites US 9,123,456 alone for §102 and alternatively combines US 9,123,456 with US 8,765,432 under §103. Break down which claim elements are fully anticipated vs only partially disclosed.";

async function main() {
  const { retrieve } = await import("../src/lib/rag");
  const { analyzeRejection, renderAnalysisMarkdown } = await import("../src/lib/analyze-rejection");

  console.log("[diag] retrieving...");
  const chunks = await retrieve(QUERY, { caseId: CASE_ID, kCase: 8, kGlobal: 6 });
  console.log(`[diag] got ${chunks.length} chunks (${chunks.filter(c => c.origin === "case").length} case)`);

  console.log("[diag] calling analyzeRejection...");
  try {
    const result = await analyzeRejection(QUERY, chunks);
    console.log("[diag] success! limitations:", result.limitations.length);
    console.log("[diag] §102 satisfied:", result.s102Satisfied);
    console.log("[diag] failing limitations:", result.s102FailingLimitationIds.join(", ") || "(none)");
    console.log();
    console.log("===== MARKDOWN OUTPUT =====");
    console.log(renderAnalysisMarkdown(result));
  } catch (e) {
    console.error("[diag] FAILED:", e);
    if (e instanceof Error && e.cause) console.error("[diag] cause:", e.cause);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
