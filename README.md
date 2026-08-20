# Patent Prosecution Assistant

Patent Prosecution Assistant is a ChatGPT-style research tool for patent prosecutors built with Next.js and the Claude API. It combines a per-case workspace and document upload with grounded retrieval over a public-domain corpus of MPEP, 35 U.S.C., 37 C.F.R., PTAB, and Federal Circuit text, plus predefined actions that return structured, source-attributed drafts.

## About

A general-purpose chatbot answers patent-law questions fluently and wrongly, inventing section numbers that sound right. This project takes the opposite bet: retrieve first from the actual public-domain text, then answer only from what came back. Retrieval picks the answer mode, not the model. GROUNDED when sources exist, with each assertion labeled `BINDING` for statute and regulation or `PERSUASIVE` for MPEP guidance; FRAMEWORK only when retrieval returns nothing, so a gap is stated rather than filled.

Generation runs on hosted Claude, tiered by task: Opus at `xhigh` effort for claim-by-claim § 102/§ 103 analysis and drafting, Sonnet for routine drafting, Haiku for mechanical formatting. Effort is a per-request compute dial with no local-inference equivalent, and it is the reason the project moved off Llama 3.1 8B — see [Confidentiality](#confidentiality) for what that means for client documents.

Live captures of the running app, not mockups: a pgvector corpus of MPEP §§ 2131/2143 and the most-cited 35 U.S.C. sections, plus three uploaded case documents. The screenshots predate the move to hosted Claude; the layout is unchanged.

### Global Research

Retrieval over the global corpus only, with no active case. Answers open with the source label the system prompt assigns.

<p align="center">
  <img src="docs/screenshots/01-global-research.jpg" width="720" alt="Global research chat answering a 35 U.S.C. 102 anticipation question, citing the statute as BINDING and quoting Verdegaal Bros. v. Union Oil">
</p>

### Case Workspace

Per-case view with the predefined-action bar, a document panel showing per-file chunk counts, and a chat that searches the case's own documents alongside the global corpus.

<p align="center">
  <img src="docs/screenshots/02-case-workspace.jpg" width="720" alt="Case workspace for application 17/123,456 with three uploaded documents and a chat answer breaking down claim 1">
</p>

### Predefined Actions

Per-case actions return structured output rendered from a fixed template rather than free-form prose, so section headings are guaranteed and every finding is attributed to the case document it came from.

## Core Features

- Create a case, upload its documents, and have them chunked and embedded automatically
- Ask questions answered from retrieved text, with a source label on every assertion
- Search the case's own documents and the global corpus together, or research the corpus alone
- Draft the next motion, draft a response with claim amendments, draft the next client email, and get case status
- Draft a full patent application from an invention disclosure, section by section, with .docx export
- Seed the corpus from official sources with per-fetcher dry-run and idempotent reseed flags
- Look up live application data from the USPTO Open Data Portal

## Drafting

Two drafting paths, grounded differently.

**Amendments and responses** run under the same rule as everything else: the office action and the current claims are both in the record, so nothing is asserted that retrieval did not supply. The drafter consumes `analyzeRejection`'s verdicts rather than re-deciding which limitations fail — two independent calls would eventually disagree, and a response whose remarks contradict its own claim amendments is worse than no response. Output is a claim listing marked up per 37 C.F.R. § 1.121(c) plus remarks traversing each rejection. Any claim adding language without a written-description citation is flagged: unsupported additions are new matter under 35 U.S.C. § 132(a).

**Application drafting** is the one place the grounding rule bends, and the bend is narrow. The invention disclosure is in the record once uploaded, so every technical fact still traces to a source. What is newly permitted is composing *form* — section scaffolding, transitional phrasing, claim syntax. What is never permitted is inventing substance: an embodiment, an advantage, a numeric range, or a result the inventor did not disclose. Where the disclosure is silent the drafter emits `[ATTORNEY INPUT NEEDED: ...]` and continues. Those markers are counted and surfaced, because an admitted gap is recoverable and invented matter in a filed application is not.

Mechanical checks run on every draft: the abstract against the 150-word limit in 37 C.F.R. § 1.72(b), and claim-by-claim antecedent basis under § 112(b) by walking each dependency chain for a `the X` with no earlier `a X`.

Document type is chosen at upload, not inferred. Drafting refuses to run without a document explicitly marked as the invention disclosure — guessing which upload is the disclosure risks producing a plausible application for the wrong invention.

## Confidentiality

This tool sends case documents to third-party APIs. Before pointing it at a live matter, know exactly what leaves the machine:

| Data | Goes to | When |
|---|---|---|
| Retrieved chunks of case documents + your query | Anthropic | Every chat turn and predefined action |
| Full text of every chunk (case and corpus) | Voyage AI | Once per document at upload, and on `npm run reembed` |
| Full text of the invention disclosure | Anthropic | Every section of an application draft (8 calls) |
| Uploaded files themselves | Cloudflare R2, or local `./uploads/` | At upload |
| Application number | USPTO Open Data Portal | "Get status" only |

An earlier version of this project ran entirely on local Ollama and could honestly claim no client document left the machine. That is no longer true, and the tradeoff was deliberate: Llama 3.1 8B could not sustain claim-by-claim § 102/§ 103 analysis, and three rounds of prompt tightening made it worse rather than better.

Points a practitioner should confirm independently rather than take from this README:

- **Unpublished applications are confidential under 35 U.S.C. § 122.** Whether transmitting them to a third-party API is consistent with your obligations — including the duty of confidentiality and any client engagement terms — is your determination to make, not this tool's.
- **Anthropic does not train on API inputs or outputs by default**, and zero-retention arrangements are available on request. Verify current terms directly rather than relying on this file.
- **Voyage receives document text**, not just queries. Embedding is not a lesser exposure than generation.
- **There is no per-user isolation.** `src/lib/auth.ts` is a single-user stub with a hardcoded ID. Do not deploy this multi-tenant as-is.

If local-only operation matters more than analytical quality for your use, set `EMBED_PROVIDER=ollama` and point `src/lib/llm.ts` back at a local model — the seams are still there, and the 8B ceiling is documented in `backlog.txt` items 4b/4c.

## Swapping providers

Both migrations are one file each, but the embedding swap has an ordering constraint that the code enforces.

**Generation** — `src/lib/llm.ts` exports four task profiles (`REASONING`, `DRAFTING`, `FAST`, `UTILITY`), each bundling a model with its `maxOutputTokens` and provider options. Call sites spread a profile rather than naming a model, so retiering is a one-line change per profile. Note that `maxOutputTokens` caps thinking *and* response text together: Opus 5 thinks by default, so a limit sized only for the JSON payload will truncate mid-answer.

**Embeddings** — `src/lib/embed.ts` selects a backend with `EMBED_PROVIDER` (`voyage` by default, `ollama` for the legacy path). Changing the embedding model invalidates every stored vector: cosine similarity is only meaningful within one embedding space, and comparing across two returns plausible-looking nonsense rather than an error.

That failure is silent, so it is guarded rather than documented. `embedding_meta` records which model wrote the vectors, `src/lib/rag.ts` checks it before every search, and `npm run reembed` updates it only after a complete pass. Switch models and the next query fails loudly with instructions instead of quietly returning the wrong sources.

`npm run reembed` re-embeds in place from `chunks.text` — it does not re-scrape Cornell, the eCFR API, PTAB, or CAFC, and does not re-parse uploaded PDFs. It also preserves case UUIDs, which the eval harnesses hardcode.

## Tech Stack

- Next.js 16 and React 19
- TypeScript
- Tailwind v4 and shadcn/ui
- Vercel AI SDK v6
- Drizzle ORM
- Postgres with pgvector
- Anthropic Claude for generation (Opus 5 / Sonnet 5 / Haiku 4.5, tiered by task)
- Voyage AI for embeddings (`voyage-law-2`, 1024 dims)
- Cloudflare R2, with a local filesystem fallback
- USPTO Open Data Portal

Generation and embeddings are separate providers by necessity, not preference: Anthropic ships no embedding model. The AI SDK makes this explicit — `@ai-sdk/anthropic` types `embeddingModel()` as returning `never` and throws at runtime. Retrieval therefore runs on Voyage, whose `voyage-law-2` is legal-domain tuned and fixed at 1024 dimensions, matching the `chunks.embedding` column exactly.

The provider seams are `src/lib/llm.ts` (generation, tiered) and `src/lib/embed.ts` (embeddings).

## Project Structure

- `src/app/`: Next.js App Router routes, server actions, and API handlers
- `src/lib/`: retrieval, prompts, chunking, embeddings, chat model, and the USPTO client
- `src/lib/prompts.ts`: GROUNDED / FRAMEWORK / OUT-OF-SCOPE system prompts
- `src/lib/rag.ts`: pgvector cosine retrieval, filtered by case
- `src/lib/db/schema.ts`: Drizzle schema, where the chunks table is the vector store
- `scripts/ingest/`: corpus fetchers and the shared embedding pipeline
- `scripts/uspto/`: Open Data Portal smoke tests
- `backlog.txt`: ordered work list
- `docs/screenshots/`: README images

## Running Locally

1. Start Postgres with pgvector:
   ```bash
   docker run -d --name patent-pg -p 5432:5432 \
     -e POSTGRES_PASSWORD=dev pgvector/pgvector:pg16
   ```
   [Neon](https://neon.tech) works too: free, and it supports pgvector.

2. Configure the environment and push the schema:
   ```bash
   cp .env.example .env.local        # fill in DATABASE_URL, ANTHROPIC_API_KEY, VOYAGE_API_KEY
   npm install
   npm run db:push
   ```

3. Embed the corpus. Retrieval refuses to run against vectors written by a
   different embedding model than the one configured, so this is required
   before the app will answer anything:
   ```bash
   npm run reembed
   ```

4. Run the dev server at http://localhost:3000:
   ```bash
   npm run dev
   ```

## Seeding the Global Corpus

Retrieval only works well once the corpus is seeded. Every fetcher supports `--dry-run` to preview without DB writes and `--clear-existing` for idempotent reseeds.

```bash
# MPEP, current USPTO HTML
npm run ingest:mpep -- --section 2131 --clear-existing
npm run ingest:mpep -- --chapter 2100 --clear-existing

# 35 U.S.C., Cornell LII
npm run ingest:usc  -- --core --clear-existing          # 20 most-cited sections
npm run ingest:usc  -- --part II --clear-existing       # entire Part II (patentability)

# 37 C.F.R., eCFR Versioner API
npm run ingest:cfr  -- --clear-existing                 # default parts 1, 11, 41, 42
npm run ingest:cfr  -- --part 1 --clear-existing

# PTAB precedential / informative decisions, PDF
npm run ingest:ptab -- --designation precedential --clear-existing
npm run ingest:ptab -- --filter "Aqua|Apple"

# Federal Circuit opinions, PDF (most-recent ~25 only)
npm run ingest:fed-circuit -- --limit 5 --clear-existing
npm run ingest:fed-circuit -- --origin all

# Local .txt / .md files into the global corpus
npm run ingest:local -- --path ./corpus/mpep-2106.txt --doc-type mpep --citation "MPEP 2106"
```

Source choices, where they are not obvious: Cornell LII for U.S.C. because uscode.house.gov is JSF-rendered; eCFR for C.F.R. via the documented JSON/XML versioner API; www.cafc.uscourts.gov for Federal Circuit because CourtListener now requires an API token. Details in `memory/corpus-source-decisions.md`.

## USPTO Open Data Portal

`USPTO_ODP_KEY` in `.env.local` unlocks the file-wrapper endpoints (`/applications/{n}/meta-data`, `/documents`, search). Smoke-test a key without printing it:

```bash
npm run uspto:status -- --application 18045436
```

## Backlog

`backlog.txt` at the repo root is the ordered, in-place status list, prefixed `[DONE]`, `[WIP]`, or `[TODO]`. It mirrors a live kanban board on EC2 (panini board id=2). When you start or finish an item, update both `backlog.txt` and the board using the helpers in `scripts/kanban/`, which are gitignored.

Next up: citation verification post-pass, reranker over top-50 retrieval, conversation memory.

## Notes

- Working prototype, single-user. Auth is a hardcoded stub and the Auth.js v5 swap-in is backlogged.
- Chat has no memory across turns yet. Retrieval runs on the last user message, not the full conversation.
- There is no citation-verification pass yet, so the 8B model still emits the occasional section number that is not in the retrieved set.
- ~~Assistant output renders as plain text, so Markdown in a response shows literally.~~ Fixed — output now renders through `react-markdown`, including the `<u>`/`<s>` amendment markup that 37 C.F.R. § 1.121 requires. The screenshots above predate this.
- FRAMEWORK mode is deliberately binary. It fires only when retrieval returns zero sources, after an earlier version dropped into it whenever any single load-bearing document was missing.

## License

Private / not yet licensed.
