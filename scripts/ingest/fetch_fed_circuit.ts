import { loadEnvConfig } from "@next/env";
import { parseArgs } from "node:util";
import { PDFParse } from "pdf-parse";
import {
  ingestTextSources,
  parsePositiveInt,
  type IngestTextSource,
} from "./shared";

// Federal Circuit opinions ingestion.
//
// Source: https://www.cafc.uscourts.gov/home/case-information/opinions-orders/
// The page renders a server-side <table> of recent dispositions where each
// <tr> has seven <td>s: Date | Docket | Origin | Type | Caption+PDF link |
// Designation | filename. Origins include:
//   PTO  → patent applications coming from the USPTO/PTAB
//   DCT  → district court appeals
//   ITC  → International Trade Commission
//   CFC  → Court of Federal Claims
//   RIT  → relating-to (mandamus etc.)
// We default to PTO + OPINION + Precedential because that's the slice
// most directly load-bearing for prosecution; the user can broaden via
// flags. CourtListener was considered but its v3 REST API now requires
// auth, and the CAFC page already gives us clean PDF links without any
// account setup.

const INDEX_URL = "https://www.cafc.uscourts.gov/home/case-information/opinions-orders/";
const CAFC_ORIGIN = "https://www.cafc.uscourts.gov";

type Origin = "PTO" | "DCT" | "ITC" | "CFC" | "RIT" | "PVP" | "OTHER";
type DocType = "OPINION" | "ORDER" | "ERRATA";
type Designation = "Precedential" | "Nonprecedential" | "Rule 36" | "Errata" | "Other";

type Row = {
  date: string;     // mm/dd/yyyy
  docket: string;   // e.g. 24-1140
  origin: Origin;
  type: DocType;
  caption: string;
  pdfUrl: string;
  designation: Designation;
};

type CliOptions = {
  origins: Origin[] | "all";
  types: DocType[];
  designations: Designation[];
  filter?: RegExp;
  limit?: number;
  batchSize: number;
  clearExisting: boolean;
  dryRun: boolean;
  delayMs: number;
};

const USAGE = `Usage:
  npm run ingest:fed-circuit -- [--origin PTO|DCT|ITC|all] [options]

Source:
  ${INDEX_URL}
  (Most-recent ~25–30 dispositions only; CAFC does not expose an
   historical archive without account-gated tooling.)

Options:
  --origin, -o       Origin: PTO, DCT, ITC, CFC, RIT, PVP, OTHER, or 'all'.
                     Repeatable. Default: PTO.
  --type, -t         OPINION, ORDER, or ERRATA. Repeatable. Default: OPINION.
  --designation, -d  Precedential, Nonprecedential, "Rule 36", Errata.
                     Repeatable. Default: Precedential.
  --filter, -f       Case-insensitive regex applied to case captions.
  --limit            Maximum opinions to ingest (smoke tests).
  --batch-size       Embedding batch size. Defaults to 32.
  --clear-existing   Delete matching global fed_circuit chunks before insert.
  --dry-run          Fetch + parse PDFs without DB/Ollama side effects.
  --delay-ms         Delay between CAFC PDF requests. Defaults to 500.
  --help, -h         Show this help.

Examples:
  npm run ingest:fed-circuit -- --limit 2 --dry-run
  npm run ingest:fed-circuit -- --origin PTO --origin DCT --clear-existing
  npm run ingest:fed-circuit -- --origin all --designation Precedential --designation Nonprecedential
`;

function fail(message: string): never {
  console.error(`\n${message}\n\n${USAGE}`);
  process.exit(1);
}

function valuesAsArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function parseCli(): CliOptions | "help" {
  const { values } = parseArgs({
    options: {
      origin: { type: "string", short: "o", multiple: true },
      type: { type: "string", short: "t", multiple: true },
      designation: { type: "string", short: "d", multiple: true },
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

  const rawOrigins = valuesAsArray(values.origin).map((s) => s.trim());
  let origins: Origin[] | "all";
  if (rawOrigins.length === 0) {
    origins = ["PTO"];
  } else if (rawOrigins.some((o) => o.toLowerCase() === "all")) {
    origins = "all";
  } else {
    origins = rawOrigins.map((o) => o.toUpperCase() as Origin);
  }

  const rawTypes = valuesAsArray(values.type).map((s) => s.toUpperCase());
  const types: DocType[] = rawTypes.length === 0
    ? ["OPINION"]
    : (rawTypes as DocType[]);

  const rawDes = valuesAsArray(values.designation).map((s) => s.trim());
  const designations: Designation[] = rawDes.length === 0
    ? ["Precedential"]
    : (rawDes as Designation[]);

  return {
    origins,
    types,
    designations,
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

function parseIndex(html: string): Row[] {
  // Each row has id="table_1_row_N" with seven <td>s. Parse them
  // individually rather than relying on table layout.
  const rowRe = /<tr[^>]+id="table_1_row_\d+"[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: Row[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const row = m[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 6) continue;

    const date = stripTags(cells[0]);
    const docket = stripTags(cells[1]);
    const origin = (stripTags(cells[2]) || "OTHER").toUpperCase() as Origin;
    const type = (stripTags(cells[3]) || "OPINION").toUpperCase() as DocType;
    const captionCell = cells[4];
    const designation = (stripTags(cells[5]) || "Other") as Designation;

    const linkMatch = captionCell.match(/<a[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const href = linkMatch[1];
    const pdfUrl = href.startsWith("http") ? href : `${CAFC_ORIGIN}${href.startsWith("/") ? "" : "/"}${href}`;
    const caption = stripTags(linkMatch[2])
      .replace(/\s*\[(OPINION|ORDER|ERRATA)\]\s*$/i, "")
      .trim();

    rows.push({ date, docket, origin, type, caption, pdfUrl, designation });
  }
  return rows;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
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

function formatDate(mmddyyyy: string): string {
  // 05/22/2026 → May 22, 2026
  const m = mmddyyyy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return mmddyyyy;
  const month = ["Jan.","Feb.","Mar.","Apr.","May","June","July","Aug.","Sept.","Oct.","Nov.","Dec."][parseInt(m[1],10)-1] ?? mmddyyyy;
  return `${month} ${parseInt(m[2],10)}, ${m[3]}`;
}

function citation(row: Row): string {
  const dateStr = formatDate(row.date);
  return `${row.caption}, No. ${row.docket} (Fed. Cir. ${dateStr}) (${row.designation.toLowerCase()})`;
}

function source(row: Row): string {
  return `CAFC ${row.docket}`;
}

async function main() {
  const options = parseCli();
  if (options === "help") {
    console.log(USAGE);
    return;
  }

  loadEnvConfig(process.cwd());

  console.log(`[ingest:fed-circuit] fetching index ${INDEX_URL}`);
  const indexRes = await fetchUrl(INDEX_URL);
  const html = await indexRes.text();
  const allRows = parseIndex(html);
  console.log(`[ingest:fed-circuit] index lists ${allRows.length} recent disposition(s)`);

  let rows = allRows.filter((r) => {
    if (options.origins !== "all" && !options.origins.includes(r.origin)) return false;
    if (!options.types.includes(r.type)) return false;
    if (!options.designations.some((d) => d.toLowerCase() === r.designation.toLowerCase())) return false;
    if (options.filter && !options.filter.test(r.caption)) return false;
    return true;
  });
  if (typeof options.limit === "number") {
    rows = rows.slice(0, options.limit);
  }
  console.log(`[ingest:fed-circuit] selected ${rows.length} opinion(s) after filters`);

  if (rows.length === 0) {
    fail(
      `No opinions matched. Index sample: ${allRows
        .slice(0, 3)
        .map((r) => `[${r.origin}/${r.type}/${r.designation}] ${r.caption}`)
        .join(" | ")}`,
    );
  }

  const sources: IngestTextSource[] = [];
  for (const row of rows) {
    try {
      const buf = await downloadPdf(row.pdfUrl);
      const { text, pages } = await pdfToText(buf);
      const cleaned = cleanPdfText(text);
      if (cleaned.length < 500) {
        console.log(`[ingest:fed-circuit]   ✗ ${row.caption}: ${cleaned.length} chars (looks empty), skipping`);
        continue;
      }
      const cite = citation(row);
      sources.push({
        text: `${cite}\n\n${cleaned}`,
        docType: "fed_circuit",
        source: source(row),
        sourceUrl: row.pdfUrl,
        citation: cite,
      });
      console.log(`[ingest:fed-circuit]   ✓ [${row.origin}] ${cite} — ${pages}p, ${cleaned.length.toLocaleString()} chars`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[ingest:fed-circuit]   ✗ ${row.caption}: ${msg.split("\n")[0]}`);
    }
    if (options.delayMs > 0) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }
  }

  if (sources.length === 0) {
    fail("No CAFC opinions successfully parsed.");
  }

  const totalChunks = await ingestTextSources({
    sources,
    batchSize: options.batchSize,
    clearExisting: options.clearExisting,
    dryRun: options.dryRun,
  });

  const mode = options.dryRun ? "dry run complete" : "ingest complete";
  console.log(
    `[ingest:fed-circuit] ${mode}: ${sources.length} opinion(s), ${totalChunks} chunk(s)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
