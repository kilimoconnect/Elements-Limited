/**
 * Sales invoice and delivery note PDFs for a posted sale. Pure rendering from
 * the data passed in (no database), so the same sale always prints the same.
 * Producing them posts nothing.
 */
import { A4, SimplePdf, textWidth } from "@/lib/pdf/simple-pdf";

export interface SaleDocData {
  company: { name: string; legal_name: string | null; address: string | null; phone: string | null; email: string | null };
  branch: { name: string; address: string | null; phone: string | null };
  customer: { code: string; name: string; address: string | null; phone: string | null; tin: string | null; vat_number: string | null };
  document_number: string; document_date: string; due_date: string | null; customer_reference: string | null;
  lines: { sku: string; description: string; unit: string | null; quantity: number; unit_price: number; discount: number; tax_name: string | null; line_total: number }[];
  subtotal: number; discount_total: number; net_total: number; tax_total: number; grand_total: number;
  amount_paid: number; outstanding: number;
  payments: { account: string; amount: number }[];
  approved_by: string | null; approved_at: string | null;
}

const TZ = "Africa/Dar_es_Salaam";
function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(iso)).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
const money = (n: number) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 });

const L = 40, R = A4.width - 40, W = R - L;

/** Company header, document title and number; returns the y below it. */
function header(pdf: SimplePdf, s: SaleDocData, title: string): number {
  let y = A4.height - 50;
  pdf.text(L, y, s.company.legal_name || s.company.name, 15, "bold");
  pdf.textRight(R, y, title, 15, "bold");
  y -= 14;
  const contact = [s.company.address, s.company.phone, s.company.email].filter(Boolean).join("  |  ");
  if (contact) pdf.textFit(L, y, contact, W * 0.62, 8);
  pdf.textRight(R, y, s.document_number, 10, "bold");
  y -= 11;
  pdf.textFit(L, y, `Branch: ${s.branch.name}${s.branch.address ? `, ${s.branch.address}` : ""}${s.branch.phone ? `  Tel ${s.branch.phone}` : ""}`, W * 0.62, 8);
  y -= 8;
  pdf.line(L, y, R, y, 1);
  return y - 16;
}

function customerBox(pdf: SimplePdf, s: SaleDocData, y: number, title: string): number {
  const h = 62, bw = W / 2 - 6;
  pdf.rect(L, y - h, bw, h);
  pdf.text(L + 6, y - 12, title, 7.5, "bold");
  pdf.textFit(L + 6, y - 25, `${s.customer.code} - ${s.customer.name}`, bw - 12, 10, "bold");
  pdf.textFit(L + 6, y - 37, s.customer.address ?? "", bw - 12, 8.5);
  pdf.textFit(L + 6, y - 48, [s.customer.phone ? `Tel ${s.customer.phone}` : "", s.customer.tin ? `TIN ${s.customer.tin}` : "", s.customer.vat_number ? `VRN ${s.customer.vat_number}` : ""].filter(Boolean).join("   "), bw - 12, 8.5);

  const x = L + W / 2 + 6;
  pdf.rect(x, y - h, bw, h);
  const kv = (row: number, k: string, v: string) => { pdf.text(x + 6, y - 14 - row * 12, k, 8); pdf.textRight(x + bw - 6, y - 14 - row * 12, v, 8.5, "bold"); };
  kv(0, "Date", fmtDate(s.document_date));
  kv(1, "Due date", fmtDate(s.due_date));
  kv(2, "Customer reference", s.customer_reference || "-");
  kv(3, "Approved", s.approved_by ? `${s.approved_by}, ${fmtDate(s.approved_at)}` : "-");
  return y - h - 16;
}

interface Col { h: string; x: number; w: number; right?: boolean }
function table(pdf: SimplePdf, s: SaleDocData, title: string, y0: number, cols: Col[], row: (i: number) => string[]): number {
  let y = y0;
  const head = () => {
    pdf.rect(L, y - 16, W, 16, 0.5, 0.9);
    cols.forEach((c) => (c.right ? pdf.textRight(c.x, y - 11, c.h, 8.5, "bold") : pdf.text(c.x, y - 11, c.h, 8.5, "bold")));
    y -= 16;
  };
  head();
  s.lines.forEach((_, i) => {
    if (y < 190) {
      pdf.text(L, 40, `${s.document_number} - continued`, 7.5);
      pdf.addPage(); y = header(pdf, s, title); head();
    }
    const r = row(i);
    cols.forEach((c, j) => (c.right ? pdf.textRight(c.x, y - 12, r[j], 9) : pdf.textFit(c.x, y - 12, r[j], c.w, 9)));
    pdf.line(L, y - 17, R, y - 17, 0.3);
    y -= 17;
  });
  return y;
}

function signatures(pdf: SimplePdf, s: SaleDocData, title: string, y: number, boxes: string[]) {
  if (y < 150) { pdf.addPage(); header(pdf, s, title); }
  y = Math.min(y, 160);
  const sigW = (W - (boxes.length - 1) * 12) / boxes.length;
  boxes.forEach((t, i) => {
    const x = L + i * (sigW + 12);
    pdf.rect(x, y - 92, sigW, 92);
    pdf.text(x + 6, y - 12, t, 8, "bold");
    ["Name", "Signature", "Date"].forEach((f, j) => {
      pdf.text(x + 6, y - 34 - j * 22, f, 7.5);
      pdf.line(x + 6 + textWidth(f, 7.5) + 4, y - 35 - j * 22, x + sigW - 6, y - 35 - j * 22, 0.4);
    });
  });
}

export function renderSaleInvoice(s: SaleDocData): Uint8Array {
  const title = "TAX INVOICE";
  const pdf = new SimplePdf();
  let y = header(pdf, s, title);
  y = customerBox(pdf, s, y, "BILL TO");
  const cols: Col[] = [
    { h: "#", x: L + 4, w: 18 }, { h: "Description", x: L + 24, w: 200 },
    { h: "Qty", x: R - 230, w: 50, right: true }, { h: "Price", x: R - 160, w: 70, right: true },
    { h: "Disc", x: R - 95, w: 60, right: true }, { h: "Amount", x: R - 4, w: 80, right: true },
  ];
  y = table(pdf, s, title, y, cols, (i) => {
    const l = s.lines[i];
    return [String(i + 1), `${l.description}${l.tax_name ? ` (${l.tax_name})` : ""}`, qty(l.quantity), money(l.unit_price), money(l.discount), money(l.line_total)];
  });

  y -= 8;
  const tot = (label: string, v: number, bold = false) => {
    pdf.text(R - 200, y - 10, label, 9, bold ? "bold" : "regular");
    pdf.textRight(R - 4, y - 10, money(v), 9, bold ? "bold" : "regular");
    y -= 14;
  };
  tot("Subtotal", s.subtotal); tot("Discount", s.discount_total); tot("Net", s.net_total); tot("Tax (VAT)", s.tax_total);
  pdf.line(R - 200, y + 1, R, y + 1, 0.8);
  tot("Total (TZS)", s.grand_total, true); tot("Paid", s.amount_paid); tot("Balance due", s.outstanding, true);
  if (s.payments.length) {
    y -= 4;
    pdf.textFit(L, y - 10, `Payment: ${s.payments.map((p) => `${p.account} ${money(p.amount)}`).join(", ")}`, W, 8.5);
    y -= 16;
  }
  signatures(pdf, s, title, y - 10, ["Issued by", "Customer"]);
  pdf.text(L, 48, `${s.document_number} - issued ${fmtDate(s.document_date)} - ${s.company.name}`, 7);
  pdf.text(L, 38, "Thank you for your business.", 7);
  return pdf.toBytes({ title: `Invoice ${s.document_number}` });
}

export function renderSaleDeliveryNote(s: SaleDocData): Uint8Array {
  const title = "DELIVERY NOTE";
  const pdf = new SimplePdf();
  let y = header(pdf, s, title);
  y = customerBox(pdf, s, y, "DELIVER TO");
  const cols: Col[] = [
    { h: "#", x: L + 4, w: 18 }, { h: "SKU", x: L + 24, w: 80 }, { h: "Description", x: L + 108, w: 250 },
    { h: "Quantity", x: R - 60, w: 70, right: true }, { h: "Unit", x: R - 50, w: 46 },
  ];
  y = table(pdf, s, title, y, cols, (i) => {
    const l = s.lines[i];
    return [String(i + 1), l.sku, l.description, qty(l.quantity), l.unit ?? ""];
  });
  const total = s.lines.reduce((a, l) => a + Number(l.quantity), 0);
  pdf.text(L + 108, y - 12, "Total quantity", 9, "bold");
  pdf.textRight(R - 60, y - 12, qty(total), 9, "bold");
  y -= 28;
  signatures(pdf, s, title, y, ["Issued by (store)", "Delivered by", "Received by (customer)"]);
  pdf.text(L, 48, `Delivery note for invoice ${s.document_number} - ${fmtDate(s.document_date)}`, 7);
  pdf.text(L, 38, "Please check the goods on delivery. Quantities are as invoiced.", 7);
  return pdf.toBytes({ title: `Delivery note ${s.document_number}` });
}
