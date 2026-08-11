# Patent Prosecution Assistant

A ChatGPT-style legal-LLM tool for patent prosecutors. Per-case workspace, document upload, predefined actions ("draft next motion", "predict next USPTO action"), grounded in a public-domain corpus of MPEP, 35 USC, 37 CFR, PTAB, and Federal Circuit caselaw.

## About

A general-purpose chatbot answers patent-law questions fluently and wrongly, inventing section numbers that sound right. This project takes the opposite bet: retrieve first from the actual public-domain text, then answer only from what came back. Retrieval picks the answer mode, not the model. GROUNDED when sources exist, with each assertion labeled `BINDING` for statute and regulation or `PERSUASIVE` for MPEP guidance; FRAMEWORK only when retrieval returns nothing, so a gap is stated rather than filled.

Screenshots below are live captures of the running app, not mockups: local Llama 3.1 8B over a pgvector corpus of MPEP §§ 2131/2143 and the 20 most-cited 35 U.S.C. sections, plus three uploaded case documents.

### Global research: grounded, no active case

Retrieval over the global corpus only. Answers open with the source label the system prompt assigns (`BINDING` for statute/regulation, `PERSUASIVE` for MPEP guidance).

![Global research chat answering a 35 U.S.C. 102 anticipation question, citing the statute as BINDING and quoting Verdegaal Bros. v. Union Oil](docs/screenshots/01-global-research.jpg)

### Case workspace: uploaded docs + corpus

Per-case view: predefined-action bar, document panel with per-file chunk counts, and a chat that searches the case's own documents alongside the global corpus.

![Case workspace for application 17/123,456 with three uploaded documents and a chat answer breaking down claim 1](docs/screenshots/02-case-workspace.jpg)

### Predefined actions: structured output

`Predict next USPTO action` returns a typed prediction (action, probability, reasoning, alternatives) with each finding attributed to the case document it came from.

![Predict next USPTO action dialog predicting FINAL_OA with HIGH probability, citing office_action.txt and prior_art_us9123456.txt](docs/screenshots/03-predict-next-action.jpg)

**Who it is for:** a solo practitioner or small firm wanting a case workspace over their own file wrapper without shipping client documents to a third-party API. Everything runs on local Ollama, so no LLM keys are required and no document leaves the machine. Swapping to a hosted provider is a two-file change (`src/lib/llm.ts`, `src/lib/embed.ts`).

**Status:** working prototype, single-user. UI, schema, retrieval, streaming chat, upload and embedding, all five corpus fetchers, and the structured analyzers run end to end. Auth is a stub and chat has no memory across turns. Two rough edges are visible in the shots above: output renders as plain text, so Markdown `**bold**` shows literally, and with no citation-verification pass yet the 8B model still emits the occasional section number that isn't in the retrieved set. Ordered work list in `backlog.txt`.

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind v4 · shadcn/ui · Vercel AI SDK v6 · Drizzle ORM · Postgres + pgvector · **local Ollama** (Llama 3.1 8B chat + mxbai-embed-large embeddings, 1024 dims) · Cloudflare R2 · USPTO Open Data Portal.

Local-first: no third-party LLM API keys required to run. Swap to a hosted provider by changing the provider in `src/lib/llm.ts` and `src/lib/embed.ts`.

## Setup

1. **Postgres with pgvector** (one-time):
   ```bash
   docker run -d --name patent-pg -p 5432:5432 \
     -e POSTGRES_PASSWORD=dev pgvector/pgvector:pg16
   ```
   Or use [Neon](https://neon.tech) — free, supports pgvector.

2. **Ollama** (one-time, ~5.4 GB on disk):
   ```bash
   brew services start ollama
   ollama pull llama3.1:8b           # chat model
   ollama pull mxbai-embed-large     # embeddings (1024 dims)
   ```

3. **Env + schema**:
   ```bash
   cp .env.example .env.local        # fill in DATABASE_URL, USPTO_ODP_KEY, R2 keys
   npm install
   npm run db:push
   ```

4. **Dev server**:
   ```bash
   npm run dev                       # http://localhost:3000
   ```

## Seeding the global corpus

The chat/predefined-actions are grounded retrieval — they only work well once the corpus is seeded. Each fetcher supports `--dry-run` for previewing without DB writes and `--clear-existing` for idempotent reseeds.

```bash
# MPEP — current USPTO HTML
npm run ingest:mpep -- --section 2131 --clear-existing
npm run ingest:mpep -- --chapter 2100 --clear-existing

# 35 U.S.C. — Cornell LII
npm run ingest:usc  -- --core --clear-existing          # 20 most-cited sections
npm run ingest:usc  -- --part II --clear-existing       # entire Part II (patentability)

# 37 C.F.R. — eCFR Versioner API
npm run ingest:cfr  -- --clear-existing                 # default parts 1, 11, 41, 42
npm run ingest:cfr  -- --part 1 --clear-existing

# PTAB precedential / informative decisions — PDF
npm run ingest:ptab -- --designation precedential --clear-existing
npm run ingest:ptab -- --filter "Aqua|Apple"

# Federal Circuit opinions — PDF (most-recent ~25 only)
npm run ingest:fed-circuit -- --limit 5 --clear-existing
npm run ingest:fed-circuit -- --origin all

# Ingest local .txt / .md files into the global corpus
npm run ingest:local -- --path ./corpus/mpep-2106.txt --doc-type mpep --citation "MPEP 2106"
```

Source choices (where it's not obvious): Cornell LII for USC because uscode.house.gov is JSF-rendered; eCFR for CFR via the documented JSON/XML versioner API; www.cafc.uscourts.gov for Federal Circuit because CourtListener now requires an API token. Details in `memory/corpus-source-decisions.md`.

## USPTO Open Data Portal

`USPTO_ODP_KEY` in `.env.local` unlocks the patent file-wrapper endpoints (`/applications/{n}/meta-data`, `/documents`, search). Smoke-test a key without printing it:

```bash
npm run uspto:status -- --application 18045436
```

## Backlog

`backlog.txt` at repo root is the ordered, in-place status list. It mirrors a live kanban board on EC2 (panini board id=2). Status prefixes:

- `[DONE]` — shipped
- `[WIP]`  — currently being worked on
- `[TODO]` — not started

When you start or finish a backlog item, update both `backlog.txt` and the kanban board (helpers in `scripts/kanban/`, gitignored).

Currently done: all four corpus fetchers (35 USC, 37 CFR, PTAB, Fed Cir). Next up: structured output schemas for the predefined actions, citation verification post-pass, reranker.

## Project layout

```
src/
  app/                # Next.js App Router (routes, server actions, API)
  lib/
    auth.ts           # single-user stub (Auth.js v5 swap-in is backlogged)
    chunk.ts          # text splitter
    embed.ts          # local Ollama embeddings
    llm.ts            # local Ollama chat model
    prompts.ts        # GROUNDED / FRAMEWORK / OUT-OF-SCOPE system prompts
    rag.ts            # pgvector cosine retrieval (filters by case_id)
    uspto.ts          # ODP client (24h TTL cache in uspto_cache table)
    db/schema.ts      # Drizzle schema (chunks table is the vector store)
scripts/
  ingest/             # corpus fetchers + shared embedding pipeline
  uspto/              # ODP smoke tests
  kanban/             # local kanban admin helpers (gitignored)
backlog.txt           # ordered work list — see "Backlog" above
```

## License

Private / not yet licensed.
