# Patent Prosecution Assistant

A ChatGPT-style legal-LLM tool for patent prosecutors. Per-case workspace, document upload, predefined actions ("draft next motion", "predict next USPTO action"), grounded in a public-domain corpus of MPEP, 35 USC, 37 CFR, PTAB, and Federal Circuit caselaw.

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind v4 · shadcn/ui · Vercel AI SDK v5 · Drizzle ORM · Postgres + pgvector · Qwen2.5-72B via Together AI · OpenAI embeddings · Cloudflare R2 · USPTO Open Data Portal.

## Setup

1. Postgres with pgvector:
   ```bash
   docker run -d --name patent-pg -p 5432:5432 \
     -e POSTGRES_PASSWORD=dev pgvector/pgvector:pg16
   ```
   Or use [Neon](https://neon.tech) — free, supports pgvector.

2. Copy env:
   ```bash
   cp .env.example .env.local
   # Fill in TOGETHER_API_KEY, OPENAI_API_KEY, USPTO_ODP_KEY, R2 keys, DATABASE_URL
   ```

3. Push schema:
   ```bash
   npm run db:push
   ```

4. Dev server:
   ```bash
   npm run dev
   ```

Visit http://localhost:3000.

## Project status

Scaffolded skeleton. UI works, schema is real, LLM and USPTO clients are wired but the global corpus is empty until ingestion scripts (`scripts/ingest/`) are completed.

See `CLAUDE.md` for the detailed architecture and known TODOs.

## License

Private / not yet licensed.
