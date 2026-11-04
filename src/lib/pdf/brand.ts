/**
 * Elements Limited document style for generated PDFs: logo header with the
 * company address, brand-green headings and tables, signature panels, a
 * footer with page numbers and a faint watermark. Shared by delivery notes,
 * GRNs and sales invoices so every document looks the same.
 */
import { A4, SimplePdf, textWidth, type Rgb } from "./simple-pdf";
import { ICON_JPEG, LOGO_JPEG } from "./brand-assets";

export const C = {
  green: [0, 54, 22] as Rgb,       // #003616 forest green (logo text)
  mid: [14, 88, 38] as Rgb,        // #0E5826 icon green
  leaf: [147, 196, 52] as Rgb,     // #93C434 leaf green
  tint: [243, 247, 238] as Rgb,    // pale green panel
  zebra: [248, 250, 246] as Rgb,
  line: [213, 223, 208] as Rgb,
  text: [30, 42, 34] as Rgb,
  muted: [95, 111, 101] as Rgb,
  white: [255, 255, 255] as Rgb,
};

export const L = 40, R = A4.width - 40, W = R - L;
/** Content stops above this y; below is the footer. */
export const BOTTOM = 70;

export interface Company { name: string; legal_name: string | null; address: string | null; phone: string | null; email: string | null }

/** A new branded document with the brand images registered. */
export function brandedPdf(): SimplePdf {
  const pdf = new SimplePdf();
  pdf.addJpeg("logo", LOGO_JPEG);
  pdf.addJpeg("icon", ICON_JPEG);
  return pdf;
}

const addressLines = (c: Company) => (c.address ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/**
 * Page header: brand bar, logo and company address on the left; document
 * title and number on the right. Returns the y where content starts.
 */
export function header(pdf: SimplePdf, c: Company, title: string, number: string, sub?: string): number {
  const top = A4.height;
  pdf.fillRect(0, top - 8, A4.width, 8, C.green);
  pdf.fillRect(0, top - 10.5, A4.width, 2.5, C.leaf);

  const logoW = 150, logoH = (logoW * LOGO_JPEG.height) / LOGO_JPEG.width;
  pdf.image("logo", L - 4, top - 30 - logoH, logoW, logoH);
  let y = top - 30 - logoH - 17;
  for (const ln of addressLines(c).slice(0, 3)) { pdf.textFit(L, y, ln, W * 0.55, 8, "regular", C.muted); y -= 10; }
  const contact = [c.phone?.trim() ? `Tel ${c.phone.trim()}` : "", c.email?.trim() ?? ""].filter(Boolean).join("   |   ");
  if (contact) { pdf.textFit(L, y, contact, W * 0.55, 8, "regular", C.muted); y -= 10; }

  // Title block
  const ty = top - 42;
  pdf.textRight(R, ty, title, 19, "bold", C.green);
  const label = `No. ${number}`;
  const pw = textWidth(label, 10, "bold") + 18;
  pdf.fillRect(R - pw, ty - 26, pw, 18, C.tint, { color: C.leaf, width: 0.8 });
  pdf.textRight(R - 9, ty - 20.5, label, 10, "bold", C.green);
  if (sub) pdf.textRight(R, ty - 40, sub, 8, "regular", C.muted);

  const end = Math.min(y, ty - 48) - 4;
  pdf.line(L, end, R, end, 0.8, C.line);
  return end - 16;
}

/** A bordered panel with a tinted title strip; returns the y inside it below the strip. */
export function panel(pdf: SimplePdf, x: number, y: number, w: number, h: number, title: string): number {
  pdf.fillRect(x, y - h, w, h, C.white, { color: C.line, width: 0.8 });
  pdf.fillRect(x, y - 16, w, 16, C.tint);
  pdf.fillRect(x, y - 16, 3, 16, C.leaf);
  pdf.text(x + 9, y - 11.5, title.toUpperCase(), 7.5, "bold", C.green);
  return y - 16;
}

/** Label / value rows inside a panel. */
export function kvRows(pdf: SimplePdf, x: number, y: number, w: number, rows: [string, string][], step = 13) {
  rows.forEach(([k, v], i) => {
    const yy = y - 12 - i * step;
    pdf.text(x + 9, yy, k, 8, "regular", C.muted);
    pdf.textRight(x + w - 9, yy, v || "-", 8.5, "bold", C.text);
  });
}

/** A highlighted banner line (e.g. the destination). */
export function banner(pdf: SimplePdf, y: number, label: string, value: string): number {
  pdf.fillRect(L, y - 26, W, 26, C.green);
  pdf.fillRect(L, y - 26, 5, 26, C.leaf);
  pdf.text(L + 14, y - 16.5, label, 8, "bold", C.leaf);
  pdf.textFit(L + 14 + textWidth(label, 8, "bold") + 8, y - 17, value, W - 40 - textWidth(label, 8, "bold"), 12, "bold", C.white);
  return y - 38;
}

export interface Col { h: string; x: number; w: number; right?: boolean }

/**
 * A table with a green header row and banded rows. `cont` redraws the page
 * header when the table runs onto a new page and returns the new y.
 */
export function table(pdf: SimplePdf, y0: number, cols: Col[], rows: string[][], cont: () => number, totals?: string[]): number {
  let y = y0;
  const head = () => {
    pdf.fillRect(L, y - 18, W, 18, C.green);
    cols.forEach((c) => (c.right ? pdf.textRight(c.x, y - 12, c.h, 8, "bold", C.white) : pdf.text(c.x, y - 12, c.h, 8, "bold", C.white)));
    y -= 18;
  };
  head();
  rows.forEach((r, i) => {
    if (y - 18 < BOTTOM + 30) { pdf.addPage(); y = cont(); head(); }
    if (i % 2 === 1) pdf.fillRect(L, y - 18, W, 18, C.zebra);
    cols.forEach((c, j) => (c.right ? pdf.textRight(c.x, y - 12.5, r[j] ?? "", 9, "regular", C.text) : pdf.textFit(c.x, y - 12.5, r[j] ?? "", c.w, 9, "regular", C.text)));
    pdf.line(L, y - 18, R, y - 18, 0.4, C.line);
    y -= 18;
  });
  if (totals) {
    pdf.fillRect(L, y - 20, W, 20, C.tint);
    pdf.line(L, y, R, y, 1, C.green);
    cols.forEach((c, j) => {
      if (!totals[j]) return;
      if (c.right) pdf.textRight(c.x, y - 13.5, totals[j], 9, "bold", C.green);
      else pdf.text(c.x, y - 13.5, totals[j], 9, "bold", C.green);
    });
    y -= 20;
  }
  return y;
}

/** Signature panels, kept together near the bottom of the page. */
export function signatures(pdf: SimplePdf, y: number, titles: string[], cont: () => number): number {
  const h = 96;
  if (y - h < BOTTOM + 8) { pdf.addPage(); y = cont(); }
  y = Math.min(y, BOTTOM + 8 + h + 20);
  const gap = 12, sw = (W - gap * (titles.length - 1)) / titles.length;
  titles.forEach((t, i) => {
    const x = L + i * (sw + gap);
    const inner = panel(pdf, x, y, sw, h, t);
    ["Name", "Signature", "Date"].forEach((f, j) => {
      const yy = inner - 22 - j * 22;
      pdf.text(x + 9, yy, f, 7.5, "regular", C.muted);
      pdf.line(x + 9 + textWidth(f, 7.5) + 6, yy - 1, x + sw - 9, yy - 1, 0.5, C.line);
    });
  });
  return y - h - 10;
}

/**
 * Footer and watermark on every page; call once, after all content.
 * `note` is a short line above the footer on the last page.
 */
export function finish(pdf: SimplePdf, c: Company, docLabel: string, note?: string) {
  pdf.eachPage((page, total) => {
    // Watermark drawn faintly over the page, so panels and table bands do not hide it.
    const s = 300;
    pdf.image("icon", (A4.width - s) / 2, (A4.height - s) / 2 - 20, s, s, 0.04);
    pdf.withOpacity(0.045, () => pdf.textRotated(95, 230, (c.legal_name || c.name).toUpperCase(), 46, 35, "bold", C.green));

    if (note && page === total) pdf.textFit(L, BOTTOM - 8, note, W, 7.5, "regular", C.muted);
    pdf.line(L, BOTTOM - 18, R, BOTTOM - 18, 0.8, C.leaf);
    const addr = addressLines(c).map((s) => s.replace(/[.,]+$/, "")).join(", ");
    pdf.textFit(L, BOTTOM - 30, `${c.legal_name || c.name}${addr ? `  -  ${addr}` : ""}`, W - 140, 6.5, "regular", C.muted);
    pdf.textFit(L, BOTTOM - 40, [c.phone?.trim() ? `Tel ${c.phone.trim()}` : "", c.email?.trim() ?? "", "www.elements.co.tz"].filter(Boolean).join("   |   "), W - 140, 6.5, "regular", C.muted);
    pdf.textRight(R, BOTTOM - 30, docLabel, 7, "bold", C.green);
    pdf.textRight(R, BOTTOM - 40, `Page ${page} of ${total}`, 7, "regular", C.muted);
    pdf.fillRect(0, 0, A4.width, 6, C.green);
  });
}

const TZ = "Africa/Dar_es_Salaam";
/** DD/MM/YYYY for dates, DD/MM/YYYY HH:MM (Dar es Salaam) for timestamps. */
export function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(iso)).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
export const qty = (v: number) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 4 });
export const money = (v: number) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Splits text into lines that fit `maxWidth` at the given size (breaks at spaces). */
export function wrapText(text: string, maxWidth: number, size: number, font: "regular" | "bold" = "regular"): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/).map((p) => p.trim()).filter(Boolean)) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, size, font) > maxWidth) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}
