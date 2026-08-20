// Regression test for the §112(b) antecedent-basis checker.
//
// There is no test runner in this project, so this is a script: run it with
// `npm run test:antecedent`. It exists because the first version of the checker
// raised 39 flags on a 29-claim generated draft, most of them non-terms like
// "the first die while continuing". A checker that noisy gets ignored, which is
// worse than not having one.
//
// Two directions are asserted, and both matter:
//   - clean claims must stay quiet (no false-positive flood)
//   - genuinely broken claims must still raise (no silent regression to a
//     checker that passes everything)

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

type Claim = { number: number; dependsOn: number; text: string };

// A well-formed set: every "the X" has an "a X" earlier in its chain.
const CLEAN: Claim[] = [
  {
    number: 1,
    dependsOn: 0,
    text:
      "A method comprising: receiving a plurality of documents; generating a relevance score for each document of the plurality of documents; and ranking the plurality of documents by the relevance score.",
  },
  { number: 2, dependsOn: 1, text: "The method of claim 1, wherein the relevance score is recomputed periodically." },
  { number: 3, dependsOn: 2, text: "The method of claim 2, further comprising displaying a ranked list, wherein the ranked list is scrollable." },
];

// Each entry pairs a defect with the substring the flag must mention.
const BROKEN: Array<{ label: string; claims: Claim[]; expect: RegExp }> = [
  {
    label: "definite reference with no introduction",
    claims: [{ number: 1, dependsOn: 0, text: "A method comprising: receiving a signal; and adjusting the gain based on the signal." }],
    expect: /the gain/,
  },
  {
    label: "dependent claim referencing a higher-numbered claim",
    claims: [
      { number: 1, dependsOn: 0, text: "A method comprising receiving a signal." },
      { number: 2, dependsOn: 5, text: "The method of claim 5, wherein the signal is analog." },
    ],
    expect: /depends on claim 5/,
  },
  {
    label: "dependent claim referencing a claim that does not exist",
    claims: [
      { number: 1, dependsOn: 0, text: "A method comprising receiving a signal." },
      { number: 3, dependsOn: 99, text: "The method of claim 99, further comprising nothing." },
    ],
    expect: /does not exist|depends on claim 99/,
  },
  {
    label: "self-referential dependency",
    claims: [{ number: 4, dependsOn: 4, text: "The method of claim 4, wherein a widget is blue." }],
    expect: /depends on claim 4/,
  },
];

async function main() {
  const { checkAntecedents } = await import("../src/lib/draft-application");
  let failures = 0;

  const cleanFlags = checkAntecedents(CLEAN);
  if (cleanFlags.length === 0) {
    console.log(`✓ clean claim set produces no flags`);
  } else {
    failures++;
    console.log(`✗ clean claim set produced ${cleanFlags.length} false positive(s):`);
    cleanFlags.forEach((f) => console.log(`    ${f}`));
  }

  for (const c of BROKEN) {
    const flags = checkAntecedents(c.claims);
    const hit = flags.some((f) => c.expect.test(f));
    if (hit) {
      console.log(`✓ ${c.label}`);
    } else {
      failures++;
      console.log(`✗ ${c.label} — expected ${c.expect}, got: ${flags.join(" | ") || "(nothing)"}`);
    }
  }

  console.log(failures === 0 ? `\nPASS — ${1 + BROKEN.length} checks` : `\nFAIL — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
