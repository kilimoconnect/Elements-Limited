import "server-only";

import ExcelJS from "exceljs";
import { A4 } from "@/lib/pdf/simple-pdf";
import { brandedPdf, finish, wrapText, C, L, R, W, BOTTOM, type Company } from "@/lib/pdf/brand";
import { LOGO_JPEG } from "@/lib/pdf/brand-assets";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Report exports shared by the report pages: an Excel workbook (one row per
 * record, real numbers, header filters) and a branded A4 PDF (compact table
 * that wraps long text, totals row, page numbers).
 */
export type ColType = "text" | "number" | "money" | "date" | "datetime";
export interface ExportColumn { key: string; header: string; type?: ColType; width?: number }
export interface ExportSheet { name: string; columns: ExportColumn[]; rows: Record<string, unknown>[]; totals?: Record<string, number | string> }

const TZ = "Africa/Dar_es_Salaam";
const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
export const fmtDay = (v: unknown) => (v ? dateFmt.format(new Date(String(v).length === 10 ? `${v}T12:00:00Z` : String(v))) : "");
export const fmtDayTime = (v: unknown) => (v ? `${fmtDay(v)} ${timeFmt.format(new Date(String(v)))}` : "");
export const fmtNum = (v: unknown) => Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 4 });
export const fmtMoney = (v: unknown) => Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function companyFor(companyId: string): Promise<Company> {
  const { data } = await createAdminClient().from("companies").select("name, legal_name, address, phone, email").eq("id", companyId).single();
  return (data ?? { name: "Elements Limited", legal_name: null, address: null, phone: null, email: null }) as Company;
}

const safe = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-");

/** Excel workbook: title rows, styled header, real dates and numbers, filters, frozen header, totals. */
export async function xlsxResponse(fileName: string, title: string, subtitle: string, sheets: ExportSheet[]): Promise<Response> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Elements ERP";
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name.slice(0, 31), { views: [{ state: "frozen", ySplit: 4 }] });
    ws.getCell("A1").value = title; ws.getCell("A1").font = { bold: true, size: 14, color: { argb: "FF003616" } };
    ws.getCell("A2").value = subtitle; ws.getCell("A2").font = { size: 10, color: { argb: "FF5F6F65" } };
    const head = ws.getRow(4);
    sh.columns.forEach((c, i) => {
      const cell = head.getCell(i + 1);
      cell.value = c.header;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF003616" } };
      cell.alignment = { vertical: "middle", wrapText: true, horizontal: c.type && c.type !== "text" ? "right" : "left" };
      ws.getColumn(i + 1).width = c.width ?? (c.type === "money" ? 16 : c.type === "number" ? 11 : c.type === "date" ? 12 : c.type === "datetime" ? 17 : 22);
    });
    head.height = 28;
    sh.rows.forEach((r, ri) => {
      const row = ws.getRow(5 + ri);
      sh.columns.forEach((c, i) => {
        const v = r[c.key];
        const cell = row.getCell(i + 1);
        if (v === null || v === undefined || v === "") { cell.value = null; return; }
        if (c.type === "money" || c.type === "number") { cell.value = Number(v); cell.numFmt = c.type === "money" ? "#,##0.00" : "#,##0.####"; }
        else if (c.type === "date") { cell.value = new Date(String(v).length === 10 ? `${v}T00:00:00Z` : new Date(new Date(String(v)).getTime() + 3 * 3600_000).toISOString().slice(0, 10) + "T00:00:00Z"); cell.numFmt = "dd/mm/yyyy"; }
        else if (c.type === "datetime") { cell.value = new Date(new Date(String(v)).getTime() + 3 * 3600_000); cell.numFmt = "dd/mm/yyyy hh:mm"; }
        else cell.value = String(v);
      });
      if (ri % 2 === 1) row.eachCell({ includeEmpty: true }, (cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAF6" } }; });
    });
    if (sh.totals) {
      const tr = ws.getRow(5 + sh.rows.length);
      sh.columns.forEach((c, i) => {
        const v = sh.totals![c.key];
        if (v === undefined) return;
        const cell = tr.getCell(i + 1);
        cell.value = typeof v === "number" ? v : v;
        if (typeof v === "number") cell.numFmt = c.type === "money" ? "#,##0.00" : "#,##0.####";
        cell.font = { bold: true, color: { argb: "FF003616" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F7EE" } };
      });
    }
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + Math.max(sh.rows.length, 1), column: sh.columns.length } };
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${safe(fileName)}.xlsx"`, "Cache-Control": "private, no-store",
    },
  });
}

export interface PdfColumn { h: string; w: number; right?: boolean }

/**
 * Branded A4 report: logo and title, the period and filters, summary figures,
 * then a compact table (7.5 pt, wrapping) with a totals row. Column widths are
 * relative and scaled to the page.
 */
export function pdfReportResponse(fileName: string, company: Company, title: string, subtitle: string, kpis: [string, string][],
  columns: PdfColumn[], rows: string[][], totals?: string[]): Response {
  const pdf = brandedPdf();
  const FS = 7.5, LH = 9;
  const scale = W / columns.reduce((a, c) => a + c.w, 0);
  let x = L;
  const cols = columns.map((c) => { const w = c.w * scale; const col = { ...c, x: c.right ? x + w - 4 : x + 4, w: w - 8 }; x += w; return col; });

  const top = () => {
    const t = A4.height;
    pdf.fillRect(0, t - 8, A4.width, 8, C.green);
    pdf.fillRect(0, t - 10.5, A4.width, 2.5, C.leaf);
    const lw = 120, lh = (lw * LOGO_JPEG.height) / LOGO_JPEG.width;
    pdf.image("logo", L - 4, t - 24 - lh, lw, lh);
    pdf.textRight(R, t - 36, title, 15, "bold", C.green);
    for (const [i, ln] of wrapText(subtitle, W * 0.55, 8).slice(0, 3).entries()) pdf.textRight(R, t - 50 - i * 10, ln, 8, "regular", C.text);
    const end = t - 24 - lh - 10;
    pdf.line(L, end, R, end, 0.8, C.line);
    return end - 12;
  };
  let y = top();
  // Summary figures, in boxes across the page.
  if (kpis.length) {
    const per = Math.min(kpis.length, 4), bw = (W - (per - 1) * 6) / per;
    kpis.forEach(([k, v], i) => {
      const r = Math.floor(i / per), c = i % per, bx = L + c * (bw + 6), by = y - r * 36;
      pdf.fillRect(bx, by - 30, bw, 30, C.tint, { color: C.line, width: 0.6 });
      pdf.textFit(bx + 6, by - 11, k, bw - 12, 7, "regular", C.muted);
      pdf.textFit(bx + 6, by - 24, v, bw - 12, 10, "bold", C.green);
    });
    y -= Math.ceil(kpis.length / per) * 36 + 6;
  }
  const head = () => {
    const lines = cols.map((c) => wrapText(c.h, c.w, FS, "bold"));
    const hh = 8 + Math.max(...lines.map((l) => l.length)) * LH;
    pdf.fillRect(L, y - hh, W, hh, C.green);
    cols.forEach((c, j) => lines[j].forEach((t, k) => (c.right ? pdf.textRight(c.x, y - 9 - k * LH, t, FS, "bold", C.white) : pdf.text(c.x, y - 9 - k * LH, t, FS, "bold", C.white))));
    y -= hh;
  };
  head();
  rows.forEach((r, i) => {
    // A cell may hold several lines ("\n"); each wraps to the column width.
    const cells = cols.map((c, j) => (c.right ? String(r[j] ?? "").split("\n")
      : String(r[j] ?? "").split("\n").flatMap((ln) => (wrapText(ln, c.w, FS).length ? wrapText(ln, c.w, FS) : [""]))));
    const rh = 7 + Math.max(...cells.map((l) => l.length)) * LH;
    if (y - rh < BOTTOM + 24) { pdf.addPage(); y = top(); head(); }
    if (i % 2 === 1) pdf.fillRect(L, y - rh, W, rh, C.zebra);
    cols.forEach((c, j) => cells[j].forEach((t, k) => (c.right
      ? pdf.textRight(c.x, y - 9 - k * LH, t, FS, "regular", C.text)
      : pdf.textFit(c.x, y - 9 - k * LH, t, c.w, FS, "regular", C.text))));
    pdf.line(L, y - rh, R, y - rh, 0.3, C.line);
    y -= rh;
  });
  if (!rows.length) { pdf.text(L + 4, y - 14, "Nothing for these filters.", 9, "regular", C.muted); y -= 20; }
  if (totals) {
    if (y - 18 < BOTTOM + 24) { pdf.addPage(); y = top(); }
    pdf.fillRect(L, y - 16, W, 16, C.tint);
    pdf.line(L, y, R, y, 1, C.green);
    cols.forEach((c, j) => { const t = totals[j]; if (!t) return; if (c.right) pdf.textRight(c.x, y - 11, t, FS, "bold", C.green); else pdf.textFit(c.x, y - 11, t, c.w, FS, "bold", C.green); });
  }
  const generated = `Generated ${fmtDayTime(new Date().toISOString())}`;
  finish(pdf, company, title.toUpperCase(), generated);
  return new Response(new Blob([pdf.toBytes({ title }) as BlobPart], { type: "application/pdf" }), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${safe(fileName)}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
