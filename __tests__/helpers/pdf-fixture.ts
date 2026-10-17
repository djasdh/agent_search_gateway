/**
 * 最小可用 PDF 生成器（测试用）。
 *
 * 手工拼 xref 表，产出 PDF.js / unpdf 能正常解析的 1 页 PDF，
 * 避免把二进制 fixture 提交进仓库。
 */
export function makeMinimalPdf(text: string): Buffer {
  const header = "%PDF-1.4\n";
  const content = `BT /F1 18 Tf 20 100 Td (${text.replace(/[()\\]/g, (m) => `\\${m}`)}) Tj ET`;

  const objects: Record<number, string> = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    4: `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  };
  const count = Object.keys(objects).length;

  let body = header;
  const offsets: Record<number, number> = {};
  for (let i = 1; i <= count; i++) {
    offsets[i] = Buffer.byteLength(body, "latin1");
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefPos = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= count; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, "latin1");
}
