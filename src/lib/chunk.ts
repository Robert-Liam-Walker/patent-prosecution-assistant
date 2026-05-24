// Header-aware chunking. For patent docs the natural boundaries are
// claim numbers, "Claim Rejections" section headers in office actions,
// USC/CFR § markers, and MPEP section headers.

const HEADER_SPLITTERS = [
  /\n(?=Claim\s+\d+\s*:)/g, // "Claim 1:"
  /\n(?=Claim\s+Rejections\s*-)/gi, // OA claim-rejection section headers
  /\n(?=\s*§\s*\d+(\.\d+)?)/g, // statute/reg sections
  /\n(?=MPEP\s+§)/gi, // MPEP refs
  /\n(?=[A-Z][A-Z\s]{4,}\n)/g, // ALL CAPS HEADERS
];

const TARGET_CHARS = 2000; // ~500 tokens
const OVERLAP_CHARS = 400; // ~100 tokens

export interface Chunk {
  text: string;
  headerHint?: string;
  index: number;
}

export function chunkText(text: string, headerHint?: string): Chunk[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];

  // First pass: split on header boundaries.
  let segments: string[] = [normalized];
  for (const re of HEADER_SPLITTERS) {
    segments = segments.flatMap((s) => s.split(re).filter((x) => x.trim()));
  }

  // Second pass: any segment over TARGET_CHARS gets recursively split with overlap.
  const out: Chunk[] = [];
  let idx = 0;
  for (const seg of segments) {
    if (seg.length <= TARGET_CHARS) {
      out.push({ text: seg.trim(), headerHint, index: idx++ });
      continue;
    }
    let start = 0;
    while (start < seg.length) {
      const end = Math.min(start + TARGET_CHARS, seg.length);
      out.push({ text: seg.slice(start, end).trim(), headerHint, index: idx++ });
      if (end === seg.length) break;
      start = end - OVERLAP_CHARS;
    }
  }

  return out.filter((c) => c.text.length > 50); // drop tiny noise chunks
}
