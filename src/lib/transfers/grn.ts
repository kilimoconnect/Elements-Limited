/**
 * Goods Received Note for one supplier's goods on a transfer, issued by Head
 * Office to submit to the supplier. Pure rendering; no prices.
 */
import { A4, SimplePdf, textWidth } from "@/lib/pdf/simple-pdf";

export interface GrnData {
  number: string;
  issued_at: string;
  company: { name: string; legal_name: string | null; address: string | null; phone: string | null; email: string | null };
  supplier: {
    code: string; name: string; contact_person: string | null; phone: string | null; email: string | null;
    tin: string | null; vat_number: string | null; address: string | null; payment_terms_days: number | null;
  } | null;
  transfer: { number: string | null; date: string; reference: string | null; status: string };
  from: { code: string; name: string };
  to: { code: string; name: string; address: string | null };
  delivery_notes: string[];
  lines: { sku: string; name: string; unit: string | null; batch: string | null; sent: number; received: number; net_kg: number | null }[];
}

const TZ = "Africa/Dar_es_Salaam";
function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(iso)).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
const qty = (n: number) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 });

export function renderTransferGrn(g: GrnData): Uint8Array {
  const pdf = new SimplePdf();
  const L = 40, R = A4.width - 40, W = R - L;
  let y = A4.height - 50;

  const header = () => {
    y = A4.height - 50;
    pdf.text(L, y, g.company.legal_name || g.company.name, 15, "bold");
    pdf.textRight(R, y, "GOODS RECEIVED NOTE", 15, "bold");
    y -= 14;
    const contact = [g.company.address, g.company.phone, g.company.email].filter(Boolean).join("  |  ");
    if (contact) pdf.textFit(L, y, contact, W * 0.6, 8);
    pdf.textRight(R, y, `No. ${g.number}`, 10, "bold");
    y -= 8;
    pdf.line(L, y, R, y, 1);
    y -= 16;
  };
  header();

  // Supplier (left) and document details (right)
  const h = 100, bw = W / 2 - 6;
  pdf.rect(L, y - h, bw, h);
  pdf.text(L + 6, y - 12, "SUPPLIER", 7.5, "bold");
  const s = g.supplier;
  if (s) {
    pdf.textFit(L + 6, y - 25, `${s.code} - ${s.name}`, bw - 12, 10, "bold");
    const rows = [
      s.address ?? "",
      [s.contact_person ? `Contact: ${s.contact_person}` : "", s.phone ? `Tel ${s.phone}` : ""].filter(Boolean).join("   "),
      s.email ? `Email: ${s.email}` : "",
      [s.tin ? `TIN ${s.tin}` : "", s.vat_number ? `VRN ${s.vat_number}` : ""].filter(Boolean).join("   "),
      s.payment_terms_days != null ? `Payment terms: ${s.payment_terms_days} days` : "",
    ].filter(Boolean);
    rows.forEach((r, i) => pdf.textFit(L + 6, y - 38 - i * 12, r, bw - 12, 8.5));
  } else {
    pdf.textFit(L + 6, y - 25, "Supplier not recorded", bw - 12, 10, "bold");
    pdf.textFit(L + 6, y - 38, "No posted purchase or import was found for these products.", bw - 12, 8.5);
  }
  const x = L + W / 2 + 6;
  pdf.rect(x, y - h, bw, h);
  const kv = (row: number, k: string, v: string) => { pdf.text(x + 6, y - 14 - row * 13, k, 8); pdf.textRight(x + bw - 6, y - 14 - row * 13, v, 8.5, "bold"); };
  kv(0, "GRN date", fmtDate(g.issued_at));
  kv(1, "Transfer no.", g.transfer.number ?? "Draft");
  kv(2, "Transfer date", fmtDate(g.transfer.date));
  kv(3, "Delivery note(s)", g.delivery_notes.length ? g.delivery_notes.join(", ") : "-");
  kv(4, "From", `${g.from.code} - ${g.from.name}`);
  kv(5, "Received at", `${g.to.code} - ${g.to.name}`);
  kv(6, "Reference", g.transfer.reference || "-");
  y -= h + 16;

  const cols = [
    { h: "#", x: L + 4, w: 18 }, { h: "SKU", x: L + 24, w: 70 }, { h: "Description", x: L + 98, w: 170 }, { h: "Batch", x: L + 272, w: 60 },
    { h: "Unit", x: L + 336, w: 34 }, { h: "Sent", x: R - 120, w: 50, right: true }, { h: "Received", x: R - 60, w: 55, right: true }, { h: "Net kg", x: R - 4, w: 55, right: true },
  ];
  const head = () => {
    pdf.rect(L, y - 16, W, 16, 0.5, 0.9);
    cols.forEach((c) => (c.right ? pdf.textRight(c.x, y - 11, c.h, 8.5, "bold") : pdf.text(c.x, y - 11, c.h, 8.5, "bold")));
    y -= 16;
  };
  head();
  let tSent = 0, tRec = 0, tKg = 0;
  g.lines.forEach((ln, i) => {
    if (y < 190) { pdf.text(L, 40, `${g.number} - continued`, 7.5); pdf.addPage(); header(); head(); }
    const row = [String(i + 1), ln.sku, ln.name, ln.batch ?? "", ln.unit ?? "", qty(ln.sent), qty(ln.received), ln.net_kg == null ? "-" : qty(ln.net_kg)];
    cols.forEach((c, j) => (c.right ? pdf.textRight(c.x, y - 12, row[j], 9) : pdf.textFit(c.x, y - 12, row[j], c.w, 9)));
    pdf.line(L, y - 17, R, y - 17, 0.3);
    y -= 17;
    tSent += ln.sent; tRec += ln.received; tKg += ln.net_kg ?? 0;
  });
  pdf.text(L + 98, y - 12, "Total", 9, "bold");
  pdf.textRight(R - 120, y - 12, qty(tSent), 9, "bold");
  pdf.textRight(R - 60, y - 12, qty(tRec), 9, "bold");
  pdf.textRight(R - 4, y - 12, qty(tKg), 9, "bold");
  y -= 28;
  if (g.transfer.status !== "received") {
    pdf.textFit(L, y, "Note: the transfer is not fully received yet; Received shows what has been recorded so far.", W, 8.5);
    y -= 14;
  }

  if (y < 150) { pdf.addPage(); header(); }
  y = Math.min(y, 160);
  const sigW = W / 3 - 8;
  ["Received by (Elements)", "Checked / approved by", "Supplier representative"].forEach((title, i) => {
    const sx = L + i * (sigW + 12);
    pdf.rect(sx, y - 92, sigW, 92);
    pdf.text(sx + 6, y - 12, title, 8, "bold");
    ["Name", "Signature", "Date"].forEach((f, j) => {
      pdf.text(sx + 6, y - 34 - j * 22, f, 7.5);
      pdf.line(sx + 6 + textWidth(f, 7.5) + 4, y - 35 - j * 22, sx + sigW - 6, y - 35 - j * 22, 0.4);
    });
  });
  pdf.text(L, 48, `${g.number} - issued by Head Office ${fmtDate(g.issued_at)} - transfer ${g.transfer.number ?? "draft"}`, 7);
  pdf.text(L, 38, "Goods Received Note for submission to the supplier. Quantities only; no prices.", 7);
  return pdf.toBytes({ title: `GRN ${g.number}` });
}
