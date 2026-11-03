/**
 * Minimal PDF 1.4 writer: A4 pages, the two standard Helvetica fonts, text,
 * lines, rectangles, colours, transparency and embedded JPEG images. No
 * dependencies, so output is small and deterministic (same input, same
 * bytes). Text is limited to WinAnsi; other characters are transliterated or
 * replaced.
 */

export const A4 = { width: 595.28, height: 841.89 };

type Font = "regular" | "bold";
/** An RGB colour, each channel 0-255. */
export type Rgb = [number, number, number];

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

const rgb = (c: Rgb) => c.map((v) => (v / 255).toFixed(3)).join(" ");
const n = (v: number) => v.toFixed(2);

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

interface Image { width: number; height: number; bytes: Uint8Array }

export class SimplePdf {
  private pages: string[][] = [];
  private cur: string[] = [];
  private images = new Map<string, Image>();
  private alphas = new Map<string, number>();

  constructor() { this.pages.push(this.cur); }

  addPage() { this.cur = []; this.pages.push(this.cur); }
  get pageCount() { return this.pages.length; }
  /** Runs `draw` once per page (e.g. footers and watermarks after the content is laid out). */
  eachPage(draw: (page: number, total: number) => void) {
    const keep = this.cur;
    this.pages.forEach((ops, i) => { this.cur = ops; draw(i + 1, this.pages.length); });
    this.cur = keep;
  }

  text(x: number, y: number, s: string, size = 10, font: Font = "regular", color?: Rgb) {
    if (!s) return;
    const fill = color ? `${rgb(color)} rg ` : "";
    this.cur.push(`${fill}BT /${font === "bold" ? "F2" : "F1"} ${size} Tf ${n(x)} ${n(y)} Td (${clean(s)}) Tj ET${color ? " 0 g" : ""}`);
  }
  /** Right-aligned at x. */
  textRight(x: number, y: number, s: string, size = 10, font: Font = "regular", color?: Rgb) {
    this.text(x - textWidth(s, size, font), y, s, size, font, color);
  }
  /** Centred on x. */
  textCenter(x: number, y: number, s: string, size = 10, font: Font = "regular", color?: Rgb) {
    this.text(x - textWidth(s, size, font) / 2, y, s, size, font, color);
  }
  /** Truncates to fit maxWidth. */
  textFit(x: number, y: number, s: string, maxWidth: number, size = 10, font: Font = "regular", color?: Rgb) {
    let t = s;
    while (t.length > 1 && textWidth(t, size, font) > maxWidth) t = t.slice(0, -1);
    this.text(x, y, t === s ? s : t.slice(0, -1) + "...", size, font, color);
  }
  /** Text rotated by `deg` degrees anticlockwise about (x, y). */
  textRotated(x: number, y: number, s: string, size: number, deg: number, font: Font = "regular", color?: Rgb) {
    const r = (deg * Math.PI) / 180, c = Math.cos(r).toFixed(4), si = Math.sin(r).toFixed(4);
    const fill = color ? `${rgb(color)} rg ` : "";
    this.cur.push(`${fill}BT /${font === "bold" ? "F2" : "F1"} ${size} Tf ${c} ${si} ${(-Math.sin(r)).toFixed(4)} ${c} ${n(x)} ${n(y)} Tm (${clean(s)}) Tj ET${color ? " 0 g" : ""}`);
  }
  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, color?: Rgb) {
    this.cur.push(`${color ? `${rgb(color)} RG ` : ""}${width} w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S${color ? " 0 G" : ""}`);
  }
  rect(x: number, y: number, w: number, h: number, width = 0.5, fillGray?: number) {
    if (fillGray !== undefined) this.cur.push(`${fillGray} g ${n(x)} ${n(y)} ${n(w)} ${n(h)} re f 0 g`);
    this.cur.push(`${width} w ${n(x)} ${n(y)} ${n(w)} ${n(h)} re S`);
  }
  /** A filled rectangle, optionally outlined. */
  fillRect(x: number, y: number, w: number, h: number, fill: Rgb, stroke?: { color: Rgb; width: number }) {
    this.cur.push(`${rgb(fill)} rg ${n(x)} ${n(y)} ${n(w)} ${n(h)} re f 0 g`);
    if (stroke) this.strokeRect(x, y, w, h, stroke.color, stroke.width);
  }
  strokeRect(x: number, y: number, w: number, h: number, color: Rgb, width = 0.5) {
    this.cur.push(`${rgb(color)} RG ${width} w ${n(x)} ${n(y)} ${n(w)} ${n(h)} re S 0 G`);
  }

  /** Registers a baseline JPEG under `name` (once per document). */
  addJpeg(name: string, img: { width: number; height: number; base64: string }) {
    if (!this.images.has(name)) {
      const bin = atob(img.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      this.images.set(name, { width: img.width, height: img.height, bytes });
    }
  }
  /** Draws a registered image with its bottom-left corner at (x, y), optionally see-through (0-1). */
  image(name: string, x: number, y: number, w: number, h: number, opacity?: number) {
    if (!this.images.has(name)) throw new Error(`Image ${name} is not registered`);
    const gs = opacity !== undefined ? `${this.alpha(opacity)} gs ` : "";
    this.cur.push(`q ${gs}${n(w)} 0 0 ${n(h)} ${n(x)} ${n(y)} cm /Im_${name} Do Q`);
  }
  /** Draws with a fill/stroke opacity (0-1) for everything `draw` adds. */
  withOpacity(opacity: number, draw: () => void) {
    this.cur.push(`q ${this.alpha(opacity)} gs`);
    draw();
    this.cur.push("Q");
  }
  private alpha(a: number): string {
    const key = a.toFixed(3);
    if (!this.alphas.has(key)) this.alphas.set(key, a);
    return `/GS${key.replace(".", "_")}`;
  }

  toBytes(meta: { title?: string } = {}): Uint8Array {
    const objs: string[] = [];
    const add = (body: string) => { objs.push(body); return objs.length; };
    const catalog = add("");               // 1
    const pagesObj = add("");              // 2
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const xobjects: string[] = [];
    for (const [name, img] of this.images) {
      let bin = "";
      for (let i = 0; i < img.bytes.length; i++) bin += String.fromCharCode(img.bytes[i]);
      const id = add(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n${bin}\nendstream`);
      xobjects.push(`/Im_${name} ${id} 0 R`);
    }
    const states = [...this.alphas].map(([k, a]) => `/GS${k.replace(".", "_")} << /Type /ExtGState /ca ${a} /CA ${a} >>`);
    const resources = `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>` +
      (xobjects.length ? ` /XObject << ${xobjects.join(" ")} >>` : "") +
      (states.length ? ` /ExtGState << ${states.join(" ")} >>` : "") + " >>";
    const kids: number[] = [];
    for (const ops of this.pages) {
      const stream = ops.join("\n");
      const content = add(`<< /Length ${latin1Length(stream)} >>\nstream\n${stream}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ${resources} /Contents ${content} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    const info = add(`<< /Producer (Elements ERP) ${meta.title ? `/Title (${clean(meta.title)})` : ""} >>`);

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
