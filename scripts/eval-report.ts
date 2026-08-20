// Shared reporting helpers for the eval harnesses.
//
// Two jobs:
//   1. Classify each check as "capability" or "workaround" so that phase gates
//      can compare like for like. A capability check asks whether the analysis
//      gets the law right. A workaround check only exists to absorb a failure
//      mode of Llama 3.1 8B (malformed JSON, paraphrased evidence, skipped
//      template headers). Workaround checks are expected to become irrelevant
//      once a capable model is behind the analyzers -- a workaround check that
//      starts failing is information, not a regression.
//   2. Emit a machine-diffable JSON report so runs across phases can be
//      compared without re-reading console output.

export type CheckKind = "capability" | "workaround";

export type ReportCheck = {
  name: string;
  pass: boolean;
  kind: CheckKind;
  detail?: string;
};

export type ReportCard = {
  id: string;
  checks: ReportCheck[];
  passCount: number;
  totalCount: number;
  [k: string]: unknown;
};

export type EvalReport = {
  harness: string;
  label: string;
  createdAt: string;
  model: string;
  embedModel: string;
  totals: {
    all: { pass: number; total: number };
    capability: { pass: number; total: number };
    workaround: { pass: number; total: number };
  };
  cards: ReportCard[];
};

function tally(checks: ReportCheck[], kind?: CheckKind) {
  const subset = kind ? checks.filter((c) => c.kind === kind) : checks;
  return { pass: subset.filter((c) => c.pass).length, total: subset.length };
}

/** Parse `--json <path>` and `--label <name>` out of argv. */
export function parseReportArgs(argv: string[]): { jsonPath?: string; label: string } {
  const jsonIdx = argv.indexOf("--json");
  const labelIdx = argv.indexOf("--label");
  return {
    jsonPath: jsonIdx !== -1 ? argv[jsonIdx + 1] : undefined,
    label: labelIdx !== -1 ? argv[labelIdx + 1] : "adhoc",
  };
}

/**
 * The models that actually ran, read from the provider config rather than from
 * env vars that may be unset. An eval artifact whose model field says
 * "(default)" cannot be compared to anything later.
 */
export async function describeModels(): Promise<{ model: string; embedModel: string }> {
  const llm = await import("../src/lib/llm");
  const embed = await import("../src/lib/embed");
  const ids = [llm.REASONING, llm.DRAFTING, llm.FAST, llm.UTILITY].map(
    (p) => (p.model as unknown as { modelId?: string }).modelId ?? "unknown",
  );
  return {
    model: [...new Set(ids)].join(" + "),
    embedModel: `${process.env.EMBED_PROVIDER ?? "voyage"}:${embed.EMBED_MODEL_ID}`,
  };
}

export async function writeReport(
  harness: string,
  cards: ReportCard[],
  opts: { jsonPath?: string; label: string; model: string; embedModel: string },
): Promise<void> {
  if (!opts.jsonPath) return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const all = cards.flatMap((c) => c.checks);
  const report: EvalReport = {
    harness,
    label: opts.label,
    createdAt: new Date().toISOString(),
    model: opts.model,
    embedModel: opts.embedModel,
    totals: {
      all: tally(all),
      capability: tally(all, "capability"),
      workaround: tally(all, "workaround"),
    },
    cards,
  };
  await fs.mkdir(path.dirname(opts.jsonPath), { recursive: true });
  await fs.writeFile(opts.jsonPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  console.log(`\n[eval] wrote ${opts.jsonPath}`);
}

/** Print the capability/workaround split so the gate is visible in the console too. */
export function printSplit(cards: ReportCard[]) {
  const all = cards.flatMap((c) => c.checks);
  const cap = tally(all, "capability");
  const wrk = tally(all, "workaround");
  const pct = (p: number, t: number) => (t > 0 ? Math.round((p / t) * 100) : 100);
  console.log(
    `\n━━━ SPLIT — capability ${cap.pass}/${cap.total} (${pct(cap.pass, cap.total)}%) · ` +
      `workaround ${wrk.pass}/${wrk.total} (${pct(wrk.pass, wrk.total)}%) ━━━`,
  );
  console.log("    (only capability gates a phase; workaround checks are 8B-era guardrails)");
}
