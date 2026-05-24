// Extract text from uploaded documents (PDF, Word, txt, md).

import mammoth from "mammoth";

export async function extractText(
  buffer: Buffer,
  mime: string,
  filename: string,
): Promise<string> {
  const ext = filename.split(".").pop()?.toLowerCase();

  if (mime === "application/pdf" || ext === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    await parser.destroy();
    return result.text ?? "";
  }

  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }

  if (mime.startsWith("text/") || ext === "txt" || ext === "md") {
    return buffer.toString("utf-8");
  }

  throw new Error(`Unsupported mime/ext: ${mime} / .${ext}`);
}
