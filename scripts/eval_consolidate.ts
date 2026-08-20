// Consolidates the per-run JSON reports for one label into a single summary
// file. A phase gate compares summaries, not individual runs: a check that
// passes 3/3 is stable, one that passes 2/3 is variance and must be read as
// such rather than as a pass or a regression.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Report = {
  harness: string;
  label: string;
  model: string;
  embedModel: string;
  totals: Record<string, { pass: number; total: number }>;
  cards: Array<{ id: string; checks: Array<{ name: string; pass: boolean; kind: string; detail?: string }> }>;
};

async function main() {
  const label = process.argv[2];
  const out = process.argv[3];
  if (!label || !out) {
    console.error("usage: tsx scripts/eval_consolidate.ts <label-prefix> <out.json>");
    process.exit(1);
  }

  // The output file usually lives in evals/ and matches the same label prefix,
  // so it would otherwise be re-ingested as an input on every re-run. Exclude
  // it by name, and skip anything lacking `cards` (i.e. a summary, not a run) —
  // belt and braces, because silently consolidating a stale summary produces a
  // gate result that looks valid and is not.
  const outName = out.split("/").pop();
  const files = (await readdir("evals")).filter(
    (f) => f.startsWith(label) && f.endsWith(".json") && f !== outName,
  );
  if (files.length === 0) {
    console.error(`no per-run reports in evals/ matching ${label}*`);
    process.exit(1);
  }

  const reports: Report[] = [];
  for (const f of files) {
    const parsed = JSON.parse(await readFile(join("evals", f), "utf-8"));
    if (!Array.isArray(parsed.cards)) {
      console.warn(`[consolidate] skipping ${f} — not a per-run report`);
      continue;
    }
    reports.push(parsed);
  }
  if (reports.length === 0) {
    console.error(`no usable per-run reports matching ${label}*`);
    process.exit(1);
  }

  // check key -> pass count across runs
  const tally = new Map<string, { kind: string; passes: number; runs: number; lastDetail?: string }>();
  for (const r of reports) {
    for (const card of r.cards) {
      for (const c of card.checks) {
        const key = `${r.harness}::${card.id}::${c.name}`;
        const cur = tally.get(key) ?? { kind: c.kind, passes: 0, runs: 0 };
        cur.passes += c.pass ? 1 : 0;
        cur.runs += 1;
        if (!c.pass && c.detail) cur.lastDetail = c.detail;
        tally.set(key, cur);
      }
    }
  }

  const checks = [...tally.entries()]
    .map(([key, v]) => ({
      key,
      kind: v.kind,
      passes: v.passes,
      runs: v.runs,
      stability: v.passes === v.runs ? "stable-pass" : v.passes === 0 ? "stable-fail" : "flaky",
      detail: v.lastDetail,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const cap = checks.filter((c) => c.kind === "capability");
  const wrk = checks.filter((c) => c.kind === "workaround");
  const summary = {
    label,
    runs: reports.length,
    model: reports[0]?.model,
    embedModel: reports[0]?.embedModel,
    consolidatedAt: new Date().toISOString(),
    capability: {
      checks: cap.length,
      stablePass: cap.filter((c) => c.stability === "stable-pass").length,
      flaky: cap.filter((c) => c.stability === "flaky").length,
      stableFail: cap.filter((c) => c.stability === "stable-fail").length,
    },
    workaround: {
      checks: wrk.length,
      stablePass: wrk.filter((c) => c.stability === "stable-pass").length,
      flaky: wrk.filter((c) => c.stability === "flaky").length,
      stableFail: wrk.filter((c) => c.stability === "stable-fail").length,
    },
    checks,
  };

  await writeFile(out, JSON.stringify(summary, null, 2) + "\n", "utf-8");
  console.log(`[consolidate] ${reports.length} runs -> ${out}`);
  console.log(`  capability: ${summary.capability.stablePass}/${summary.capability.checks} stable-pass, ${summary.capability.flaky} flaky, ${summary.capability.stableFail} stable-fail`);
  console.log(`  workaround: ${summary.workaround.stablePass}/${summary.workaround.checks} stable-pass, ${summary.workaround.flaky} flaky, ${summary.workaround.stableFail} stable-fail`);
}

main();
