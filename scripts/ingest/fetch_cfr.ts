import { loadEnvConfig } from "@next/env";
import { parseArgs } from "node:util";
import {
  ingestTextSources,
  parsePositiveInt,
  type IngestTextSource,
} from "./shared";

// 37 C.F.R. ingestion via the eCFR Versioner API (ecfr.gov).
//
// Flow:
//   1. GET /api/versioner/v1/titles → discover the latest issue date for
//      Title 37 (the structure/full endpoints reject "future" dates).
//   2. GET /api/versioner/v1/full/<date>/title-37.xml?part=<n> → bulk
//      XML for a single part. Each section is a <DIV8 TYPE="SECTION"
//      N="1.111"> with a <HEAD> ("§ 1.111 …") and one or more <P>
//      paragraphs. Subsections are also <DIV8>, so we walk the full tree.
//   3. Strip XML to text, build one IngestTextSource per section with
//      doc_type='cfr' and citation '37 C.F.R. § N'.
//
// Default parts cover prosecution rules: 1 (Patents), 11 (Representation),
// 41 (BPAI/PTAB practice — legacy ex parte), 42 (AIA trial practice).

const ECFR_BASE = "https://www.ecfr.gov/api/versioner/v1";
const TITLE = "37";

// Most-cited parts in prosecution. Default when no --part / --section.
const DEFAULT_PARTS = ["1", "11", "41", "42"];

type CliOptions = {
  parts: string[];
  sections: string[];
  date?: string;
  limit?: number;
  batchSize: number;
  clearExisting: boolean;
  dryRun: boolean;
  delayMs: number;
};

const USAGE = `Usage:
  npm run ingest:cfr -- [--part <n> | --section <p.s>] [options]

Sources:
  eCFR Versioner API at ${ECFR_BASE}.
  Default parts (prosecution): ${DEFAULT_PARTS.join(", ")}.

Options:
  --part, -p        37 CFR part, e.g. 1 or 42. Can be repeated.
  --section, -s     37 CFR section, e.g. 1.111 or 42.100. Can be repeated.
                    Section pulls the section's part XML and filters.
  --date            Issue date YYYY-MM-DD. Defaults to Title 37's latest.
  --limit           Maximum sections to ingest per part (smoke tests).
  --batch-size      Embedding batch size. Defaults to 32.
  --clear-existing  Delete matching global CFR chunks before inserting.
  --dry-run         Fetch and chunk without touching the database or Ollama.
  --delay-ms        Delay between eCFR requests. Defaults to 500.
  --help, -h        Show this help.

Examples:
  npm run ingest:cfr -- --section 1.111 --dry-run
  npm run ingest:cfr -- --part 1 --limit 5 --dry-run
  npm run ingest:cfr -- --clear-existing                 # all default parts
  npm run ingest:cfr -- --part 42 --clear-existing       # AIA trial practice
`;

function fail(message: string): never {
  console.error(`\n${message}\n\n${USAGE}`);
  process.exit(1);
}

function valuesAsArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizePart(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+[a-zA-Z]?$/.test(trimmed)) {
    fail(`Invalid --part "${value}". Expected e.g. 1, 42, or 15a.`);
  }
  return trimmed;
}

function normalizeSection(value: string): string {
  // Accept "37 CFR 1.111", "§ 1.111", "1.111", "1.111(a)" → "1.111"
  const cleaned = value
    .replace(/^37\s*C\.?F\.?R\.?\s*/i, "")
    .replace(/^§?\s*/, "")
    .trim();
  const match = cleaned.match(/^(\d+)\.([\w-]+)/);
  if (!match) {
    fail(`Invalid --section "${value}". Expected e.g. 1.111 or 42.100.`);
  }
  return `${match[1]}.${match[2]}`;
}

function partOfSection(section: string): string {
  return section.split(".")[0];
}

function parseCli(): CliOptions | "help" {
  const { values } = parseArgs({
    options: {
      part: { type: "string", short: "p", multiple: true },
      section: { type: "string", short: "s", multiple: true },
      date: { type: "string" },
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

  const parts = valuesAsArray(values.part).map(normalizePart);
  const sections = valuesAsArray(values.section).map(normalizeSection);

  return {
    parts,
    sections,
    date: values.date,
    limit: values.limit ? parsePositiveInt(values.limit, 0) : undefined,
    batchSize: parsePositiveInt(values["batch-size"], 32),
    clearExisting: Boolean(values["clear-existing"]),
    dryRun: Boolean(values["dry-run"]),
    delayMs: values["delay-ms"] ? parsePositiveInt(values["delay-ms"], 500) : 500,
  };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "patent-prosecution-assistant/0.1 (+local corpus ingestion)",
      Accept: "application/xml, application/json;q=0.9, */*;q=0.8",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}\n${body.slice(0, 300)}`);
  }
  return res.text();
}

async function discoverLatestDate(): Promise<string> {
  const json = await fetchText(`${ECFR_BASE}/titles`);
  const parsed: { titles?: Array<{ number: number; latest_issue_date: string }> } = JSON.parse(json);
  const t37 = parsed.titles?.find((t) => t.number === Number(TITLE));
  if (!t37?.latest_issue_date) {
    throw new Error("Could not determine latest issue date for Title 37 from /titles.");
  }
  return t37.latest_issue_date;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function xmlBlockToText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(P|HEAD|HD\d?|FP|LI|EXTRACT|NOTE|EAR)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type SectionXml = {
  number: string; // e.g. "1.111" or "42.100"
  block: string; // full <DIV8>...</DIV8>
};

// Extract top-level DIV8 sections (TYPE="SECTION") from a part XML
// document. eCFR nests subsections inside DIV8 as well, so we only emit
// the outermost SECTION-typed DIV8s — that gives one ingest source per
// numbered section. Implementation: scan left-to-right, tracking depth
// over <DIV8 ...> open and </DIV8> close tags; emit when depth returns
// to 0 from a SECTION-typed open.
function extractSections(xml: string): SectionXml[] {
  const out: SectionXml[] = [];
  const tagRe = /<(\/?)DIV8\b([^>]*)>/gi;
  let depth = 0;
  let openStart = -1;
  let openIsSection = false;
  let openNumber = "";
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(xml)) !== null) {
    const isClose = match[1] === "/";
    if (!isClose) {
      const attrs = match[2];
      if (depth === 0) {
        openStart = match.index;
        openIsSection = /\bTYPE\s*=\s*"SECTION"/i.test(attrs);
        const nMatch = attrs.match(/\bN\s*=\s*"([^"]+)"/i);
        openNumber = nMatch?.[1] ?? "";
      }
      depth++;
    } else {
      depth--;
      if (depth === 0 && openIsSection && openNumber) {
        const end = match.index + match[0].length;
        out.push({ number: openNumber, block: xml.slice(openStart, end) });
        openStart = -1;
        openIsSection = false;
        openNumber = "";
      }
    }
  }

  return out;
}

function extractHead(block: string): string {
  const m = block.match(/<HEAD>([\s\S]*?)<\/HEAD>/i);
  if (!m) return "";
  return decodeEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

async function main() {
  const options = parseCli();
  if (options === "help") {
    console.log(USAGE);
    return;
  }

  loadEnvConfig(process.cwd());

  const date = options.date ?? (await discoverLatestDate());
  console.log(`[ingest:cfr] using Title 37 issue date ${date}`);

  // Determine which parts to fetch + which sections to keep within them.
  const sectionsByPart = new Map<string, Set<string> | "all">();
  if (options.parts.length === 0 && options.sections.length === 0) {
    for (const p of DEFAULT_PARTS) sectionsByPart.set(p, "all");
  } else {
    for (const p of options.parts) sectionsByPart.set(p, "all");
    for (const s of options.sections) {
      const p = partOfSection(s);
      const cur = sectionsByPart.get(p);
      if (cur === "all") continue;
      const set = cur ?? new Set<string>();
      set.add(s);
      sectionsByPart.set(p, set);
    }
  }

  const sources: IngestTextSource[] = [];

  for (const [part, filter] of [...sectionsByPart.entries()].sort()) {
    const url = `${ECFR_BASE}/full/${date}/title-${TITLE}.xml?part=${part}`;
    console.log(`[ingest:cfr] fetching part ${part} (${url})`);
    const xml = await fetchText(url);

    let sectionXmls = extractSections(xml);
    if (filter !== "all") {
      sectionXmls = sectionXmls.filter((s) => filter.has(s.number));
    }
    if (typeof options.limit === "number") {
      sectionXmls = sectionXmls.slice(0, options.limit);
    }

    if (sectionXmls.length === 0) {
      console.log(`[ingest:cfr]   (no sections matched for part ${part})`);
    }

    for (const sec of sectionXmls) {
      const head = extractHead(sec.block);
      const body = xmlBlockToText(sec.block);
      if (body.length < 50) {
        console.log(`[ingest:cfr]   ✗ § ${sec.number}: empty/short body, skipping`);
        continue;
      }
      const sourceUrl = `https://www.ecfr.gov/current/title-${TITLE}/chapter-I/section-${sec.number}`;
      sources.push({
        text: body, // body already begins with the HEAD line per xmlBlockToText
        docType: "cfr",
        source: `37 CFR ${sec.number}`,
        sourceUrl,
        citation: `37 C.F.R. § ${sec.number}`,
      });
      console.log(`[ingest:cfr]   ✓ § ${sec.number} (${body.length.toLocaleString()} chars) — ${head.replace(/^§\s*\S+\s*/, "")}`);
    }

    if (options.delayMs > 0) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }
  }

  if (sources.length === 0) {
    fail("No sections extracted from eCFR.");
  }

  const totalChunks = await ingestTextSources({
    sources,
    batchSize: options.batchSize,
    clearExisting: options.clearExisting,
    dryRun: options.dryRun,
  });

  const mode = options.dryRun ? "dry run complete" : "ingest complete";
  console.log(
    `[ingest:cfr] ${mode}: ${sources.length} section(s), ${totalChunks} chunk(s)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
