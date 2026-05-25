import { loadEnvConfig } from "@next/env";
import { parseArgs } from "node:util";
import { PDFParse } from "pdf-parse";
import {
  ingestTextSources,
  parsePositiveInt,
  type IngestTextSource,
} from "./shared";

// PTAB precedential + informative decisions ingestion.
//
// Source: USPTO precedential/informative decisions index at
// https://www.uspto.gov/patents/ptab/precedential-informative-decisions.
// The page lists every designated decision with a direct PDF link. We
// parse the HTML to pair each PDF with (a) its case caption from the
// link text and (b) its designation (precedential vs informative) from
// the nearest preceding marker word in the document.
//
// PDFs are downloaded and parsed with pdf-parse 2.x (PDFParse class).
// Each decision becomes one IngestTextSource with doc_type='ptab_decision'
// and citation like "Case Caption, IPR2019-00123, Paper 40 (PTAB)
// (precedential)".

const INDEX_URL = "https://www.uspto.gov/patents/ptab/precedential-informative-decisions";
const USPTO_ORIGIN = "https://www.uspto.gov";

type Designation = "precedential" | "informative";

type IndexEntry = {
  caption: string;
  pdfUrl: string;
  designation: Designation;
  caseNumber: string | null; // e.g. "IPR2019-00302" or "Ex parte Smith"
  paperNumber: string | null; // e.g. "Paper 40"
};

type CliOptions = {
  designation: "precedential" | "informative" | "all";
  filter?: RegExp;
  limit?: number;
  batchSize: number;
  clearExisting: boolean;
  dryRun: boolean;
  delayMs: number;
};

const USAGE = `Usage:
  npm run ingest:ptab -- [--designation precedential|informative|all] [options]

Source:
  ${INDEX_URL}
  (Precedential + Informative decisions; not the full PTAB docket.)

Options:
  --designation, -d   Which set to ingest. Default: precedential.
  --filter, -f        Case-insensitive regex applied to case captions.
                      Useful to narrow to a topic (e.g. "section 101", "Aqua").
  --limit             Maximum decisions to ingest (smoke tests).
  --batch-size        Embedding batch size. Defaults to 32.
  --clear-existing    Delete matching global PTAB chunks before inserting.
  --dry-run           Fetch + parse PDFs without DB/Ollama side effects.
  --delay-ms          Delay between USPTO PDF requests. Defaults to 500.
  --help, -h          Show this help.

Examples:
  npm run ingest:ptab -- --designation precedential --limit 3 --dry-run
  npm run ingest:ptab -- --filter "Apple|Aqua" --dry-run
  npm run ingest:ptab -- --designation precedential --clear-existing
`;

function fail(message: string): never {
  console.error(`\n${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseCli(): CliOptions | "help" {
  const { values } = parseArgs({
    options: {
      designation: { type: "string", short: "d" },
      filter: { type: "string", short: "f" },
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

  const designation = (values.designation ?? "precedential").toLowerCase();
  if (!["precedential", "informative", "all"].includes(designation)) {
    fail(`Invalid --designation "${values.designation}". Expected precedential, informative, or all.`);
  }

  return {
    designation: designation as CliOptions["designation"],
    filter: values.filter ? new RegExp(values.filter, "i") : undefined,
    limit: values.limit ? parsePositiveInt(values.limit, 0) : undefined,
    batchSize: parsePositiveInt(values["batch-size"], 32),
    clearExisting: Boolean(values["clear-existing"]),
    dryRun: Boolean(values["dry-run"]),
    delayMs: values["delay-ms"] ? parsePositiveInt(values["delay-ms"], 500) : 500,
  };
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

async function fetchUrl(url: string, accept = "text/html,application/xhtml+xml"): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (patent-prosecution-assistant/0.1)",
      Accept: accept,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res;
}

// Parse the index page: find every PDF link and pair it with the nearest
// preceding designation marker ("Precedential" or "Informative"). The
// markers appear as inline-emphasis spans before each block of links.
function parseIndex(html: string): IndexEntry[] {
  const markerRe = /\b(Precedential|Informative)\b/gi;
  const markers: { pos: number; designation: Designation }[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(html)) !== null) {
    markers.push({
      pos: m.index,
      designation: m[1].toLowerCase() as Designation,
    });
  }

  const linkRe = /<a[^>]*href="([^"]+\.pdf)"[^>]*>([^<]*)<\/a>/gi;
  const entries: IndexEntry[] = [];
  let lk: RegExpExecArray | null;
  while ((lk = linkRe.exec(html)) !== null) {
    const href = lk[1];
    const rawCaption = decodeEntities(lk[2]).trim();
    if (!rawCaption || rawCaption.length < 3) continue;

    // Skip Standard Operating Procedure docs — useful, but not case law.
    if (/standard operating procedure|^sop\b/i.test(rawCaption)) continue;

    const pdfUrl = href.startsWith("http") ? href : `${USPTO_ORIGIN}${href}`;
    const linkPos = lk.index;
    let designation: Designation = "precedential";
    for (let i = markers.length - 1; i >= 0; i--) {
      if (markers[i].pos < linkPos) {
        designation = markers[i].designation;
        break;
      }
    }

    const caseNumber = extractCaseNumber(href, rawCaption);
    const paperNumber = extractPaperNumber(href, rawCaption);

    entries.push({
      caption: normalizeCaption(rawCaption),
      pdfUrl,
      designation,
      caseNumber,
      paperNumber,
    });
  }

  // De-dupe by pdfUrl (the SOP appears twice on the page; some decisions
  // are linked under both designations after redesignation).
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.pdfUrl)) return false;
    seen.add(e.pdfUrl);
    return true;
  });
}

function normalizeCaption(caption: string): string {
  return caption.replace(/\s+/g, " ").trim();
}

function extractCaseNumber(href: string, caption: string): string | null {
  // Filename pattern matches IPR/CBM/PGR/Reexam numbers.
  const all = `${href} ${caption}`;
  const ipr = all.match(/\b(IPR|CBM|PGR)[\s_-]?(\d{4})[\s_-]?(\d{4,5})/i);
  if (ipr) return `${ipr[1].toUpperCase()}${ipr[2]}-${ipr[3]}`;
  const exparte = caption.match(/^(Ex parte[^,]+)/i);
  if (exparte) return exparte[1].trim();
  return null;
}

function extractPaperNumber(href: string, caption: string): string | null {
  const all = `${href} ${caption}`;
  const m = all.match(/Paper[\s_-]?(\d+)/i);
  return m ? `Paper ${m[1]}` : null;
}

async function downloadPdf(url: string): Promise<Buffer> {
  const res = await fetchUrl(url, "application/pdf");
  const arr = new Uint8Array(await res.arrayBuffer());
  return Buffer.from(arr);
}

async function pdfToText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const out = await parser.getText();
    return { text: out.text, pages: out.total };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function cleanPdfText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function citation(entry: IndexEntry): string {
  const parts: string[] = [];
  if (entry.caseNumber) parts.push(entry.caseNumber);
  if (entry.paperNumber) parts.push(entry.paperNumber);
  const tail = `(PTAB) (${entry.designation})`;
  const head = entry.caption ? `${entry.caption}` : "PTAB decision";
  const body = parts.length > 0 ? `, ${parts.join(", ")} ` : " ";
  return `${head}${body}${tail}`;
}

function source(entry: IndexEntry): string {
  if (entry.caseNumber) return `PTAB ${entry.caseNumber}`;
  // Fallback: filename stem.
  const stem = entry.pdfUrl.split("/").pop()?.replace(/\.pdf$/i, "") ?? "ptab";
  return `PTAB ${stem}`;
}

async function main() {
  const options = parseCli();
  if (options === "help") {
    console.log(USAGE);
    return;
  }

  loadEnvConfig(process.cwd());

  console.log(`[ingest:ptab] fetching index ${INDEX_URL}`);
  const indexRes = await fetchUrl(INDEX_URL);
  const html = await indexRes.text();
  const allEntries = parseIndex(html);
  console.log(`[ingest:ptab] index lists ${allEntries.length} unique decision(s)`);

  let entries = allEntries.filter((e) =>
    options.designation === "all" ? true : e.designation === options.designation,
  );
  if (options.filter) {
    entries = entries.filter((e) => options.filter!.test(e.caption));
  }
  if (typeof options.limit === "number") {
    entries = entries.slice(0, options.limit);
  }
  console.log(`[ingest:ptab] selected ${entries.length} decision(s) after filters`);

  if (entries.length === 0) {
    fail("No decisions matched the filters.");
  }

  const sources: IngestTextSource[] = [];
  for (const entry of entries) {
    try {
      const buf = await downloadPdf(entry.pdfUrl);
      const { text, pages } = await pdfToText(buf);
      const cleaned = cleanPdfText(text);
      if (cleaned.length < 500) {
        console.log(`[ingest:ptab]   ✗ ${entry.caption}: ${cleaned.length} chars (looks empty), skipping`);
        continue;
      }
      const cite = citation(entry);
      const headed = `${cite}\n\n${cleaned}`;
      sources.push({
        text: headed,
        docType: "ptab_decision",
        source: source(entry),
        sourceUrl: entry.pdfUrl,
        citation: cite,
      });
      console.log(`[ingest:ptab]   ✓ ${entry.designation.padEnd(13)} ${cite} — ${pages}p, ${cleaned.length.toLocaleString()} chars`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[ingest:ptab]   ✗ ${entry.caption}: ${msg.split("\n")[0]}`);
    }
    if (options.delayMs > 0) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }
  }

  if (sources.length === 0) {
    fail("No PTAB decisions successfully parsed.");
  }

  const totalChunks = await ingestTextSources({
    sources,
    batchSize: options.batchSize,
    clearExisting: options.clearExisting,
    dryRun: options.dryRun,
  });

  const mode = options.dryRun ? "dry run complete" : "ingest complete";
  console.log(
    `[ingest:ptab] ${mode}: ${sources.length} decision(s), ${totalChunks} chunk(s)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
