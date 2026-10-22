/**
 * Minimal PDF 1.4 writer: A4 pages, the two standard Helvetica fonts, text,
 * lines and rectangles. No dependencies and no images, so output is small and
 * deterministic (same input, same bytes). Text is limited to WinAnsi; other
 * characters are transliterated or replaced.
 */

export const A4 = { width: 595.28, height: 841.89 };

type Font = "regular" | "bold";

const MAP: Record<string, string> = { "—": "-", "–": "-", "’": "'", "‘": "'", "“": '"', "”": '"', "…": "...", "·": "-", "×": "x", "→": "->" };

function clean(s: string): string {
  let out = "";
  for (const ch of s) {
    const m = MAP[ch];
    if (m !== undefined) { out += m; continue; }
    const c = ch.codePointAt(0)!;
    out += c >= 32 && c <= 126 ? ch : c >= 160 && c <= 255 ? ch : "?";
  }
  return out.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Approximate Helvetica advance width (points) - enough for truncation and right alignment. */
export function textWidth(s: string, size: number, font: Font = "regular"): number {
  let w = 0;
  for (const ch of s) {
    if ("il.,:;'|!".includes(ch)) w += 0.28;
    else if ("ftjrI() -".includes(ch)) w += 0.36;
    else if ("mwMW@".includes(ch)) w += 0.85;
    else if (ch >= "A" && ch <= "Z") w += 0.68;
    else if (ch >= "0" && ch <= "9") w += 0.56;
    else w += 0.52;
  }
  return w * size * (font === "bold" ? 1.05 : 1);
}

export class SimplePdf {
  private pages: string[][] = [];
  private cur: string[] = [];

  constructor() { this.pages.push(this.cur); }

  addPage() { this.cur = []; this.pages.push(this.cur); }
  get pageCount() { return this.pages.length; }

  text(x: number, y: number, s: string, size = 10, font: Font = "regular") {
    if (!s) return;
    this.cur.push(`BT /${font === "bold" ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${clean(s)}) Tj ET`);
  }
  /** Right-aligned at x. */
  textRight(x: number, y: number, s: string, size = 10, font: Font = "regular") {
    this.text(x - textWidth(s, size, font), y, s, size, font);
  }
  /** Truncates to fit maxWidth. */
  textFit(x: number, y: number, s: string, maxWidth: number, size = 10, font: Font = "regular") {
    let t = s;
    while (t.length > 1 && textWidth(t, size, font) > maxWidth) t = t.slice(0, -1);
    this.text(x, y, t === s ? s : t.slice(0, -1) + "...", size, font);
  }
  line(x1: number, y1: number, x2: number, y2: number, width = 0.5) {
    this.cur.push(`${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }
  rect(x: number, y: number, w: number, h: number, width = 0.5, fillGray?: number) {
    if (fillGray !== undefined) this.cur.push(`${fillGray} g ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`);
    this.cur.push(`${width} w ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
  }

  toBytes(meta: { title?: string } = {}): Uint8Array {
    const objs: string[] = [];
    const add = (body: string) => { objs.push(body); return objs.length; };
    const catalog = add("");               // 1
    const pagesObj = add("");              // 2
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids: number[] = [];
    for (const ops of this.pages) {
      const stream = ops.join("\n");
      const content = add(`<< /Length ${latin1Length(stream)} >>\nstream\n${stream}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    const info = add(`<< /Producer (Letiq ERP) ${meta.title ? `/Title (${clean(meta.title)})` : ""} >>`);

    let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    const offsets: number[] = [];
    objs.forEach((body, i) => { offsets.push(latin1Length(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = latin1Length(out);
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}

function latin1Length(s: string) { return s.length; }
