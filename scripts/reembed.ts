// Re-embeds every row in `chunks` in place, without re-fetching or re-parsing
// any source.
//
// The corpus fetchers scrape Cornell LII, the eCFR API, the USPTO PTAB index,
// and the CAFC opinions table; uploaded case documents were parsed from PDF and
// DOCX. None of that has to happen again to change embedding provider: the raw
// text of every chunk is already stored in chunks.text, so this reads it back,
// re-embeds it, and UPDATEs the vector column.
//
// That matters beyond speed. A destructive re-seed would mint new case UUIDs,
// and the eval harnesses hardcode the existing ones
// (scripts/eval_actions.ts, scripts/eval_loop.ts) -- so a re-seed would
// silently invalidate the baseline this migration is measured against.
//
// Usage:
//   npx tsx scripts/reembed.ts --dry-run
//   npx tsx scripts/reembed.ts --limit 20
//   npx tsx scripts/reembed.ts

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import postgres from "postgres";

type Row = { id: string; text: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = arg("limit") ? Number(arg("limit")) : undefined;
const BATCH = Number(arg("batch") ?? 64);

async function main() {
  const { embedBatch, EMBED_MODEL_ID, EXPECTED_DIMENSIONS } = await import("../src/lib/embed");
  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });

  try {
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from chunks
    `;
    const total = LIMIT ? Math.min(LIMIT, count) : count;
    console.log(
      `[reembed] model=${EMBED_MODEL_ID} dims=${EXPECTED_DIMENSIONS} ` +
        `rows=${total}${LIMIT ? ` (limited from ${count})` : ""}${DRY_RUN ? " DRY-RUN" : ""}`,
    );

    if (DRY_RUN) {
      // Prove the provider works and the dimension matches before touching a
      // single row. embedBatch throws on a dimension mismatch.
      const sample = await sql<Row[]>`select id, text from chunks limit 2`;
      if (sample.length > 0) {
        const vecs = await embedBatch(sample.map((r) => r.text));
        console.log(`[reembed] dry-run ok — sample returned ${vecs[0].length} dims`);
      }
      return;
    }

    let done = 0;
    let offset = 0;
    const started = Date.now();

    // Ordered by id so the pass is resumable and deterministic.
    for (;;) {
      const take = LIMIT ? Math.min(BATCH, LIMIT - done) : BATCH;
      if (take <= 0) break;

      const rows = await sql<Row[]>`
        select id, text from chunks order by id limit ${take} offset ${offset}
      `;
      if (rows.length === 0) break;

      const embeddings = await embedBatch(rows.map((r) => r.text));

      // One transaction per batch: a crash mid-run leaves earlier batches
      // committed and this batch untouched, so a rerun resumes cleanly.
      await sql.begin(async (tx) => {
        for (let i = 0; i < rows.length; i++) {
          const literal = `[${embeddings[i].join(",")}]`;
          await tx`update chunks set embedding = ${literal}::vector where id = ${rows[i].id}`;
        }
      });

      done += rows.length;
      offset += rows.length;
      const pct = Math.round((done / total) * 100);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[reembed] ${done}/${total} (${pct}%) — ${secs}s elapsed`);
    }

    // Record provenance so retrieval can refuse to run against vectors written
    // by a different model. Only written after a full pass -- a partial run must
    // not look complete.
    if (!LIMIT) {
      await sql`
        insert into embedding_meta (id, model, dimensions, updated_at)
        values ('current', ${EMBED_MODEL_ID}, ${EXPECTED_DIMENSIONS}, now())
        on conflict (id) do update
          set model = excluded.model,
              dimensions = excluded.dimensions,
              updated_at = now()
      `;
      console.log(`[reembed] provenance recorded: ${EMBED_MODEL_ID} @ ${EXPECTED_DIMENSIONS}d`);
    } else {
      console.log(`[reembed] --limit used: provenance NOT recorded (partial pass).`);
    }

    console.log(`[reembed] done — ${done} rows re-embedded with ${EMBED_MODEL_ID}`);
    console.log(`[reembed] next: npx tsx scripts/diag_retrieval.ts to confirm ranking changed`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error("[reembed] failed:", e);
  process.exit(1);
});
