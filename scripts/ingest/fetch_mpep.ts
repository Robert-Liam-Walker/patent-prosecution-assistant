import { loadEnvConfig } from "@next/env";
import { parseArgs } from "node:util";
import {
  ingestTextSources,
  parsePositiveInt,
  type IngestTextSource,
} from "./shared";

const MPEP_BASE = "https://www.uspto.gov/web/offices/pac/mpep/";
const INDEX_URL = new URL("index.html", MPEP_BASE).toString();

type CliOptions = {
  chapters: string[];
  sections: string[];
  all: boolean;
  limit?: number;
  batchSize: number;
  clearExisting: boolean;
  dryRun: boolean;
};

const USAGE = `Usage:
  npm run ingest:mpep -- (--chapter <chapter> | --section <section> | --all) [options]

Sources:
  Fetches current MPEP HTML from ${MPEP_BASE}

Options:
  --chapter, -c     MPEP chapter, e.g. 2100. Can be repeated.
  --section, -s     MPEP section page, e.g. 2131 or 2106. Can be repeated.
  --all             Fetch all numbered MPEP chapters linked from the USPTO index.
  --limit           Maximum section pages to fetch, useful for smoke tests.
  --batch-size      Embedding batch size. Defaults to 32.
  --clear-existing  Delete matching global MPEP chunks before inserting.
  --dry-run         Fetch and chunk without touching the database or Ollama.
  --help, -h        Show this help.

Examples:
  npm run ingest:mpep -- --section 2131 --dry-run
  npm run ingest:mpep -- --chapter 2100 --clear-existing
  npm run ingest:mpep -- --all --limit 5 --dry-run
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
      chapter: { type: "string", short: "c", multiple: true },
      section: { type: "string", short: "s", multiple: true },
      all: { type: "boolean", default: false },
      limit: { type: "string" },
      "batch-size": { type: "string" },
      "clear-existing": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) return "help";

  const chapters = valuesAsArray(values.chapter).map(normalizeChapter);
  const sections = valuesAsArray(values.section).map(normalizeSection);
  const all = Boolean(values.all);

  if (!all && chapters.length === 0 && sections.length === 0) {
    fail("Provide --chapter, --section, or --all.");
  }

  return {
    chapters,
    sections,
    all,
    limit: values.limit ? parsePositiveInt(values.limit, 0) : undefined,
    batchSize: parsePositiveInt(values["batch-size"], 32),
    clearExisting: Boolean(values["clear-existing"]),
    dryRun: Boolean(values["dry-run"]),
  };
}

function normalizeChapter(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{3,4}$/.test(trimmed)) {
    fail(`Invalid chapter "${value}". Expected a chapter like 700 or 2100.`);
  }
  return trimmed.padStart(4, "0");
}

function normalizeSection(value: string): string {
  const match = value.replace(/^MPEP\s*§?\s*/i, "").match(/\d{4}/);
  if (!match) {
    fail(`Invalid section "${value}". Expected a section like 2131 or MPEP § 2106.`);
  }
  return match[0];
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "patent-prosecution-assistant/0.1 (+local corpus ingestion)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }

  return res.text();
}

function htmlUrl(file: string): string {
  return new URL(file, MPEP_BASE).toString();
}

function extractArticleHtml(html: string): string {
  const articleStart = /<div\b[^>]*id=["']article["'][^>]*>/i.exec(html);
  if (!articleStart?.index) return html;

  const start = articleStart.index + articleStart[0].length;
  const topLink = html.indexOf('<p align="right"><a href="#top">[top]</a></p>', start);
  const end = topLink > start ? topLink : html.length;
  return html.slice(start, end);
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
    mdash: "-",
    ndash: "-",
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

function extractSectionNumber(title: string): string | null {
  return (
    title.match(/^(\d{4}(?:\.\d+)?(?:\([a-z0-9]+\))*)/i)?.[1] ?? null
  );
}

function extractMpepSections(html: string, pageUrl: string): IngestTextSource[] {
  const article = extractArticleHtml(html);
  const headings = [
    ...article.matchAll(/<h1\b[^>]*class=["'][^"']*page-title[^"']*["'][^>]*>[\s\S]*?<\/h1>/gi),
  ];

  const sources: IngestTextSource[] = [];

  for (const [index, heading] of headings.entries()) {
    const title = htmlToText(heading[0]).replace(/\s+/g, " ").trim();
    const sectionNumber = extractSectionNumber(title);
    if (!sectionNumber) continue;

    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? article.length;
    const block = article.slice(start, end);
    const id = heading[0].match(/\sid=["']([^"']+)["']/i)?.[1];
    const sourceUrl = id ? `${pageUrl}#${id}` : pageUrl;
    const text = htmlToText(block);

    if (text.length < 100) continue;

    sources.push({
      text,
      docType: "mpep",
      source: `MPEP ${sectionNumber}`,
      sourceUrl,
      citation: `MPEP § ${sectionNumber}`,
    });
  }

  return sources;
}

function extractMpepChapterUrls(indexHtml: string): string[] {
  const matches = [
    ...indexHtml.matchAll(/href=["'](mpep-(\d{4})\.html)["']/gi),
  ];
  const urls = matches.map((match) => htmlUrl(match[1]));
  return [...new Set(urls)].sort();
}

function extractSectionUrls(chapterHtml: string): string[] {
  const article = extractArticleHtml(chapterHtml);
  const matches = [
    ...article.matchAll(/href=["'](s\d{4}(?:-\d{4})?\.html)(?:#[^"']*)?["']/gi),
  ];
  const urls = matches.map((match) => htmlUrl(match[1]));
  return [...new Set(urls)].sort();
}

async function collectPageUrls(options: CliOptions): Promise<string[]> {
  const urls = new Set<string>();

  if (options.all) {
    const indexHtml = await fetchHtml(INDEX_URL);
    for (const url of extractMpepChapterUrls(indexHtml)) {
      const chapterHtml = await fetchHtml(url);
      for (const sectionUrl of extractSectionUrls(chapterHtml)) {
        urls.add(sectionUrl);
      }
    }
  }

  for (const chapter of options.chapters) {
    const chapterHtml = await fetchHtml(htmlUrl(`mpep-${chapter}.html`));
    for (const sectionUrl of extractSectionUrls(chapterHtml)) {
      urls.add(sectionUrl);
    }
  }

  for (const section of options.sections) {
    urls.add(htmlUrl(`s${section}.html`));
  }

  const collected = [...urls].sort();
  return typeof options.limit === "number" ? collected.slice(0, options.limit) : collected;
}

async function main() {
  const options = parseCli();
  if (options === "help") {
    console.log(USAGE);
    return;
  }

  loadEnvConfig(process.cwd());

  const pageUrls = await collectPageUrls(options);
  if (pageUrls.length === 0) {
    fail("No MPEP section pages found.");
  }

  const sources: IngestTextSource[] = [];
  for (const pageUrl of pageUrls) {
    console.log(`[ingest:mpep] fetching ${pageUrl}`);
    const html = await fetchHtml(pageUrl);
    sources.push(...extractMpepSections(html, pageUrl));
  }

  if (sources.length === 0) {
    fail("Fetched pages did not contain ingestible MPEP sections.");
  }

  const totalChunks = await ingestTextSources({
    sources,
    batchSize: options.batchSize,
    clearExisting: options.clearExisting,
    dryRun: options.dryRun,
  });

  const mode = options.dryRun ? "dry run complete" : "ingest complete";
  console.log(
    `[ingest:mpep] ${mode}: ${pageUrls.length} page(s), ${sources.length} section(s), ${totalChunks} chunk(s)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
