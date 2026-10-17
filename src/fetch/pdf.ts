/**
 * PDF → 纯文本（unpdf：MIT，内置 Mozilla PDF.js 的 serverless build）。
 *
 * 只做正文抽取，不做版面还原；扫描件（无文本层）会返回空文本，
 * 由上层决定是报"无文本"还是落盘给链接。
 */
import { extractText, getDocumentProxy } from "unpdf";

export type PdfTextResult =
  | { ok: true; text: string; pages: number }
  | { ok: false; error: string };

export async function pdfToText(bytes: Buffer): Promise<PdfTextResult> {
  try {
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(doc, { mergePages: true });
    const merged = Array.isArray(text) ? text.join("\n") : text;
    return { ok: true, text: merged ?? "", pages: totalPages };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
