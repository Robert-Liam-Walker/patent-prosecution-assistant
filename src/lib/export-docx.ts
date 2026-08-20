// DOCX export for generated drafts.
//
// Built from the structured draft rather than by re-parsing the rendered
// markdown. The structure is already known -- section order, claim numbering,
// dependency -- so round-tripping through markdown would only be an
// opportunity to lose it.
//
// The output is a working document for the attorney to edit, not a filing-ready
// package: no ADS, no oath/declaration, no drawings, no EFS-Web formatting.
// The cover note in the document says so, because a .docx that looks finished
// invites being treated as finished.

import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from "docx";
import { SECTION_TITLES, type DraftedApplication } from "@/lib/draft-application";

function heading(text: string): Paragraph {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 180 },
  });
}

/** Split on the gap marker so it can be visually flagged inside the paragraph. */
function body(text: string): Paragraph[] {
  return text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => {
      const runs: TextRun[] = [];
      const parts = p.split(/(\[ATTORNEY INPUT NEEDED:[^\]]*\])/g);
      for (const part of parts) {
        if (!part) continue;
        if (part.startsWith("[ATTORNEY INPUT NEEDED")) {
          runs.push(new TextRun({ text: part, bold: true, highlight: "yellow" }));
        } else {
          runs.push(new TextRun({ text: part.replace(/\s+/g, " ").trim() + " " }));
        }
      }
      return new Paragraph({ children: runs, spacing: { after: 160 }, alignment: AlignmentType.JUSTIFIED });
    });
}

export async function applicationToDocx(app: DraftedApplication, caseName: string): Promise<Buffer> {
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "DRAFT — attorney review required. Not a filing-ready package: no ADS, declaration, drawings, or EFS-Web formatting. ",
          bold: true,
        }),
        new TextRun({
          text:
            app.totalGaps > 0
              ? `${app.totalGaps} point(s) are marked [ATTORNEY INPUT NEEDED] and highlighted below; each must be resolved before filing, since material added after filing is new matter under 35 U.S.C. § 132(a).`
              : "No gaps were flagged, but the specification must still be verified against the disclosure.",
        }),
      ],
      spacing: { after: 400 },
    }),
  );

  const titleSection = app.sections.find((s) => s.key === "title");
  if (titleSection) {
    children.push(
      new Paragraph({
        text: titleSection.text.trim().toUpperCase(),
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 360 },
      }),
    );
  }

  for (const s of app.sections) {
    if (s.key === "title" || s.key === "abstract") continue; // title done, abstract last
    children.push(heading(SECTION_TITLES[s.key]));
    children.push(...body(s.text));
  }

  children.push(heading("CLAIMS"));
  children.push(new Paragraph({ text: "What is claimed is:", spacing: { after: 200 } }));
  for (const c of app.claims.claims) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `${c.number}. `, bold: true }), new TextRun({ text: c.text.trim() })],
        spacing: { after: 160 },
        indent: { left: 360, hanging: 360 },
        alignment: AlignmentType.JUSTIFIED,
      }),
    );
  }

  const abstract = app.sections.find((s) => s.key === "abstract");
  if (abstract) {
    children.push(heading("ABSTRACT"));
    children.push(...body(abstract.text));
    if (app.abstractWordCount > 150) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `[${app.abstractWordCount} words — exceeds the 150-word limit in 37 C.F.R. § 1.72(b); must be shortened before filing]`,
              bold: true,
              highlight: "yellow",
            }),
          ],
          spacing: { after: 160 },
        }),
      );
    }
  }

  if (app.claims.antecedentProblems.length > 0) {
    children.push(heading("ANTECEDENT-BASIS REVIEW (not part of the filing)"));
    for (const p of app.claims.antecedentProblems) {
      children.push(new Paragraph({ text: p, bullet: { level: 0 }, spacing: { after: 80 } }));
    }
  }

  const gaps = [...app.sections.flatMap((s) => s.gapsFlagged), ...app.claims.gapsFlagged];
  if (gaps.length > 0) {
    children.push(heading("ATTORNEY INPUT NEEDED (not part of the filing)"));
    for (const g of gaps) {
      children.push(new Paragraph({ text: g, bullet: { level: 0 }, spacing: { after: 80 } }));
    }
  }

  const doc = new Document({
    creator: "Patent Prosecution Assistant",
    title: `${caseName} — draft application`,
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}
