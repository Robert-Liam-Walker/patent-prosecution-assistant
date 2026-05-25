import { loadEnvConfig } from "@next/env";
import { parseArgs } from "node:util";
import {
  ingestTextSources,
  parsePositiveInt,
  type IngestTextSource,
} from "./shared";

// 35 U.S.C. ingestion via Cornell LII (https://www.law.cornell.edu/uscode/text/35/<n>).
//
// Cornell renders each section as a tab pane with id="tab_default_1" that
// holds the clean statute body. The official authority is still the
// United States Code itself — Cornell is our parseable mirror and is
// captured as `sourceUrl` for traceability. Citation text uses the
// canonical form "35 U.S.C. § <n>".
//
// Title 35 has ~150 active sections. We hardcode them by part because
// neither Cornell nor the OLRC exposes a flat, scrapable section index
// — Cornell groups by part (JS-rendered) and OLRC is JSF-rendered.
// Missing (repealed) sections are silently skipped on 404.

const CORNELL_BASE = "https://www.law.cornell.edu/uscode/text/35/";

// Sections most commonly cited in prosecution. Default when neither
// --section nor --all nor --part is provided.
const CORE_35_SECTIONS = [
  "101", "102", "103", "112", "115",
  "120", "121", "122",
  "131", "132", "134",
  "151", "154",
  "251", "252",
  "271",
  "311", "315", "316", "321",
];

// Hardcoded section lists by part. Letters (e.g. 116A) included where
// the section is active in the current code.
const SECTIONS_BY_PART: Record<string, string[]> = {
  "I": [
    "1", "2", "3", "6",
    "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21",
    "22", "23", "24", "25", "26", "27",
    "31", "32", "33",
    "41", "42",
  ],
  "II": [
    "100", "101", "102", "103", "105",
    "111", "112", "113", "114", "115", "116", "118", "119", "120", "121", "122", "123",
    "131", "132", "133", "134", "135",
    "141", "142", "143", "144", "145", "146",
    "151", "152", "153", "154", "155", "156", "157",
    "161", "162", "163", "164",
    "171", "172", "173",
    "181", "182", "183", "184", "185", "186", "187", "188",
    "200", "201", "202", "203", "204", "205", "206", "207", "208", "209", "210", "211", "212",
  ],
  "III": [
    "251", "252", "253", "254", "255", "256", "257",
    "261", "262",
    "267",
    "271", "272", "273",
    "281", "282", "283", "284", "285", "286", "287", "288", "289",
    "290", "291", "292", "293", "294", "295", "296", "297", "298", "299",
    "301", "302", "303", "304", "305", "306", "307",
    "311", "312", "313", "314", "315", "316", "317", "318", "319",
    "321", "322", "323", "324", "325", "326", "327", "328", "329",
  ],
  "IV": [
    "351",
    "361", "362", "363", "364", "365", "366", "367", "368",
    "371", "372", "373", "374", "375", "376",
  ],
  "V": [
    "381", "382", "383", "384", "385", "386", "387", "388", "389", "390",
  ],
};

const ALL_SECTIONS = Object.values(SECTIONS_BY_PART).flat();

type CliOptions = {
  sections: string[];
  parts: string[];
  all: boolean;
  core: boolean;
  limit?: number;
  batchSize: number;
  clearExisting: boolean;
  dryRun: boolean;
  delayMs: number;
};

const USAGE = `Usage:
  npm run ingest:usc -- [--section <n> | --part <I|II|III|IV|V> | --all | --core] [options]

Sources:
  Fetches 35 U.S.C. section text from ${CORNELL_BASE}<n>
  Official authority: United States Code, Title 35.

Options:
  --section, -s     35 USC section, e.g. 102 or 116A. Can be repeated.
  --part, -p        Part of Title 35 (I, II, III, IV, V). Can be repeated.
  --all             Fetch every hardcoded section (≈140 sections).
  --core            Fetch only prosecution-core sections (default if nothing else given).
  --limit           Maximum sections to fetch, useful for smoke tests.
  --batch-size      Embedding batch size. Defaults to 32.
  --clear-existing  Delete matching global USC chunks before inserting.
  --dry-run         Fetch and chunk without touching the database or Ollama.
  --delay-ms        Delay between Cornell requests. Defaults to 250.
  --help, -h        Show this help.

Examples:
  npm run ingest:usc -- --section 102 --dry-run
  npm run ingest:usc -- --core --clear-existing
  npm run ingest:usc -- --part II --limit 5 --dry-run
  npm run ingest:usc -- --all --clear-existing
`;

function fail(message: string): never {
  console.error(`\n${message}\n\n${USAGE}`);
  process.exit(1);
}

function valuesAsArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeSection(value: string): string {
  // Accept "35 USC 102", "§ 102", "102", "102(b)" → "102"
  const match = value.replace(/^35\s*U\.?S\.?C\.?\s*/i, "")
    .replace(/^§?\s*/, "")
    .match(/^(\d{1,3}[A-Za-z]?)/);
  if (!match) {
    fail(`Invalid --section "${value}". Expected e.g. 102 or 116A.`);
  }
  return match[1];
}

function normalizePart(value: string): string {
  const upper = value.trim().toUpperCase();
  if (!SECTIONS_BY_PART[upper]) {
    fail(`Invalid --part "${value}". Expected I, II, III, IV, or V.`);
  }
  return upper;
}

function parseCli(): CliOptions | "help" {
  const { values } = parseArgs({
    options: {
      section: { type: "string", short: "s", multiple: true },
      part: { type: "string", short: "p", multiple: true },
      all: { type: "boolean", default: false },
      core: { type: "boolean", default: false },
      limit: { type: "string" },
      "batch-size": { type: "string" },
      "clear-existing": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "delay-ms": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) return "help";

  const sections = valuesAsArray(values.section).map(normalizeSection);
  const parts = valuesAsArray(values.part).map(normalizePart);
  const all = Boolean(values.all);
  const core = Boolean(values.core);

  return {
    sections,
    parts,
    all,
    core: core || (!all && sections.length === 0 && parts.length === 0),
    limit: values.limit ? parsePositiveInt(values.limit, 0) : undefined,
    batchSize: parsePositiveInt(values["batch-size"], 32),
    clearExisting: Boolean(values["clear-existing"]),
    dryRun: Boolean(values["dry-run"]),
    delayMs: values["delay-ms"] ? parsePositiveInt(values["delay-ms"], 250) : 250,
  };
}

function collectSections(options: CliOptions): string[] {
  const set = new Set<string>();
  if (options.all) ALL_SECTIONS.forEach((s) => set.add(s));
  if (options.core) CORE_35_SECTIONS.forEach((s) => set.add(s));
  for (const part of options.parts) {
    (SECTIONS_BY_PART[part] ?? []).forEach((s) => set.add(s));
  }
  for (const section of options.sections) {
    set.add(section);
  }
  // Sort numerically with letter suffixes preserved.
  const collected = [...set].sort((a, b) => {
    const aNum = parseInt(a, 10);
    const bNum = parseInt(b, 10);
    if (aNum !== bNum) return aNum - bNum;
    return a.localeCompare(b);
  });
  return typeof options.limit === "number" ? collected.slice(0, options.limit) : collected;
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "...",
    ldquo: '"',
    lsquo: "'",
    lt: "<",
    mdash: "—",
    ndash: "–",
    nbsp: " ",
    quot: '"',
    rdquo: '"',
    rsquo: "'",
    sect: "§",
  };

  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name] ?? entity);
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(h[1-6]|p|div|li|tr|ul|ol|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchSection(section: string, retries = 2): Promise<{ ok: true; html: string; url: string } | { ok: false; status: number; url: string }> {
  const url = `${CORNELL_BASE}${section}`;
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "patent-prosecution-assistant/0.1 (+local corpus ingestion)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!res.ok) {
        return { ok: false, status: res.status, url };
      }
      const html = await res.text();
      return { ok: true, html, url };
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

function extractTitle(html: string): string | null {
  // Cornell uses <h1>35 U.S. Code § N - Title</h1>
  const match = html.match(/<h1\b[^>]*>\s*35\s*U\.S\.\s*Code\s*§\s*([\w.]+)[\s—–-]+([^<]+)<\/h1>/i);
  if (!match) return null;
  return decodeEntities(match[2]).trim();
}

function extractStatuteBody(html: string): string | null {
  // The statute pane id is tab_default_1; subsequent tabs (history,
  // notes, authorities) live under tab_default_2/3/.... We slice from
  // the opening tag of tab_default_1 to the opening tag of tab_default_2
  // and rely on htmlToText to strip the trailing closing div.
  const startMatch = html.match(/<div[^>]*id=["']tab_default_1["'][^>]*>/i);
  if (!startMatch?.index) return null;
  const start = startMatch.index + startMatch[0].length;
  const endMatch = html.slice(start).match(/<div[^>]*id=["']tab_default_2["']/i);
  const end = endMatch?.index !== undefined ? start + endMatch.index : html.length;
  const block = html.slice(start, end);
  const text = htmlToText(block);
  return text.length >= 50 ? text : null;
}

async function main() {
  const options = parseCli();
  if (options === "help") {
    console.log(USAGE);
    return;
  }

  loadEnvConfig(process.cwd());

  const sectionNumbers = collectSections(options);
  if (sectionNumbers.length === 0) {
    fail("No sections selected.");
  }

  console.log(`[ingest:usc] fetching ${sectionNumbers.length} section(s) from Cornell LII`);

  const sources: IngestTextSource[] = [];
  const skipped: { section: string; reason: string }[] = [];

  for (const section of sectionNumbers) {
    const result = await fetchSection(section);
    if (!result.ok) {
      skipped.push({ section, reason: `HTTP ${result.status}` });
      console.log(`[ingest:usc]   ✗ § ${section}: HTTP ${result.status} (likely repealed)`);
    } else {
      const title = extractTitle(result.html) ?? "(no title)";
      const body = extractStatuteBody(result.html);
      if (!body) {
        skipped.push({ section, reason: "no statute pane" });
        console.log(`[ingest:usc]   ✗ § ${section}: no tab_default_1 pane found`);
      } else {
        const headed = `35 U.S.C. § ${section} — ${title}\n\n${body}`;
        sources.push({
          text: headed,
          docType: "usc",
          source: `35 USC ${section}`,
          sourceUrl: result.url,
          citation: `35 U.S.C. § ${section}`,
        });
        console.log(`[ingest:usc]   ✓ § ${section} (${body.length.toLocaleString()} chars) — ${title}`);
      }
    }
    if (options.delayMs > 0) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }
  }

  if (sources.length === 0) {
    fail("No sections successfully fetched.");
  }

  const totalChunks = await ingestTextSources({
    sources,
    batchSize: options.batchSize,
    clearExisting: options.clearExisting,
    dryRun: options.dryRun,
  });

  const mode = options.dryRun ? "dry run complete" : "ingest complete";
  console.log(
    `[ingest:usc] ${mode}: ${sources.length} section(s) ingested, ${skipped.length} skipped, ${totalChunks} chunk(s)`,
  );
  if (skipped.length > 0) {
    console.log(`[ingest:usc] skipped: ${skipped.map((s) => `${s.section} (${s.reason})`).join(", ")}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
