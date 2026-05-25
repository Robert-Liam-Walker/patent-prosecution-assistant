import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const QUERY = "I received a rejection where the examiner cites US 9,123,456 alone for §102 and alternatively combines US 9,123,456 with US 8,765,432 under §103. Break down which claim elements are fully anticipated vs only partially disclosed. Then explain whether this is a proper §102 rejection or should be §103 instead.";
const CASE_ID = "ea68b684-8f5b-4afa-b4e1-684b48b27707";

async function main() {
  const { retrieve } = await import("../src/lib/rag");
  for (const config of [
    { label: "default (kCase=8, kGlobal=6)", kCase: 8, kGlobal: 6 },
    { label: "legacy k=8 (backwards-compat)", k: 8 },
  ] as const) {
    const chunks = await retrieve(QUERY, { caseId: CASE_ID, ...config });
    console.log(`\n=== ${config.label} ===`);
    chunks.forEach((c, i) => {
      console.log(
        `  ${i + 1}. [${c.origin}] sim=${c.similarity.toFixed(3)}  ${c.source} — ${c.citation.slice(0, 70)}`,
      );
    });
    const caseCount = chunks.filter((c) => c.origin === "case").length;
    console.log(`  -> ${caseCount}/${chunks.length} case chunks`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
