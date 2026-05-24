import { loadEnvConfig } from "@next/env";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  GLOBAL_DOC_TYPES,
  ingestTextSources,
  parseGlobalDocType,
  parsePositiveInt,
  type GlobalDocType,
  type IngestTextSource,
} from "./shared";

type FileSource = {
  absolutePath: string;
  label: string;
};

type CliOptions = {
  paths: string[];
  docType: GlobalDocType;
  source?: string;
  citation?: string;
  sourceUrl?: string;
  batchSize: number;
  clearExisting: boolean;
  dryRun: boolean;
};

const USAGE = `Usage:
  npm run ingest:local -- --path <file-or-dir> --doc-type <type> [options]

Required:
  --path, -p        Text/Markdown file or directory. Can be repeated.
  --doc-type, -t    One of: ${GLOBAL_DOC_TYPES.join(", ")}

Options:
  --source, -s      Source label stored on each chunk. Defaults to file label.
  --citation, -c    Citation prefix. Defaults to the source label.
  --source-url      URL to store with each chunk.
  --batch-size      Embedding batch size. Defaults to 32.
  --clear-existing  Delete existing global chunks with the same doc type + source before inserting.
  --dry-run         Parse and chunk files without touching the database or Ollama.
  --help, -h        Show this help.

Examples:
  npm run ingest:local -- --path ./corpus/mpep-2106.txt --doc-type mpep --citation "MPEP 2106" --clear-existing
  npm run ingest:local -- -p ./corpus/usc -t usc --source "35 USC" --source-url "https://www.law.cornell.edu/uscode/text/35"
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
      path: { type: "string", short: "p", multiple: true },
      "doc-type": { type: "string", short: "t" },
      source: { type: "string", short: "s" },
      citation: { type: "string", short: "c" },
      "source-url": { type: "string" },
      "batch-size": { type: "string" },
      "clear-existing": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) return "help";

  const paths = valuesAsArray(values.path);
  if (paths.length === 0) fail("--path is required.");

  return {
    paths,
    docType: parseGlobalDocType(values["doc-type"]),
    source: values.source,
    citation: values.citation,
    sourceUrl: values["source-url"],
    batchSize: parsePositiveInt(values["batch-size"], 32),
    clearExisting: Boolean(values["clear-existing"]),
    dryRun: Boolean(values["dry-run"]),
  };
}

function isTextLike(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".txt" || ext === ".md" || ext === ".markdown";
}

async function collectFiles(inputPath: string): Promise<FileSource[]> {
  const absolutePath = path.resolve(inputPath);
  const info = await stat(absolutePath);

  if (info.isFile()) {
    if (!isTextLike(absolutePath)) return [];
    return [{ absolutePath, label: path.basename(absolutePath) }];
  }

  if (!info.isDirectory()) return [];

  async function walk(dir: string): Promise<FileSource[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
    const files: FileSource[] = [];

    for (const entry of sorted) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const childPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walk(childPath)));
      } else if (entry.isFile() && isTextLike(childPath)) {
        files.push({
          absolutePath: childPath,
          label: path.relative(absolutePath, childPath),
        });
      }
    }

    return files;
  }

  return walk(absolutePath);
}

async function collectAllFiles(paths: string[]): Promise<FileSource[]> {
  const deduped = new Map<string, FileSource>();
  for (const inputPath of paths) {
    for (const file of await collectFiles(inputPath)) {
      deduped.set(file.absolutePath, file);
    }
  }
  return [...deduped.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function sourceNameFor(file: FileSource, options: CliOptions, fileCount: number) {
  if (!options.source) return file.label;
  if (fileCount === 1) return options.source;
  return `${options.source} / ${file.label}`;
}

async function main() {
  const options = parseCli();
  if (options === "help") {
    console.log(USAGE);
    return;
  }

  loadEnvConfig(process.cwd());

  const files = await collectAllFiles(options.paths);
  if (files.length === 0) {
    fail("No .txt, .md, or .markdown files found.");
  }

  const sources: IngestTextSource[] = [];
  for (const file of files) {
    const source = sourceNameFor(file, options, files.length);
    const citationBase = options.citation ?? source;
    const text = await readFile(file.absolutePath, "utf-8");
    sources.push({
      text,
      docType: options.docType,
      source,
      sourceUrl: options.sourceUrl ?? null,
      citation: citationBase,
    });
  }

  const totalChunks = await ingestTextSources({
    sources,
    batchSize: options.batchSize,
    clearExisting: options.clearExisting,
    dryRun: options.dryRun,
  });

  const mode = options.dryRun ? "dry run complete" : "ingest complete";
  console.log(`[ingest:local] ${mode}: ${files.length} file(s), ${totalChunks} chunk(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
