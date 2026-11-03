/**
 * Sales invoice and delivery note PDFs for a posted sale. Pure rendering from
 * the data passed in (no database), so the same sale always prints the same.
 * Producing them posts nothing.
 */
import { brandedPdf, header, panel, kvRows, table, signatures, finish, fmtDate, qty, money, C, L, R, W, type Col } from "@/lib/pdf/brand";
import type { SimplePdf } from "@/lib/pdf/simple-pdf";

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

/** Customer panel (left) and document details (right); returns y below them. */
function parties(pdf: SimplePdf, s: SaleDocData, y: number, title: string): number {
  const bw = W / 2 - 6, h = 86;
  const ci = panel(pdf, L, y, bw, h, title);
  pdf.textFit(L + 9, ci - 15, s.customer.name, bw - 18, 11, "bold", C.green);
  [
    `Customer code: ${s.customer.code}`,
    s.customer.address ?? "",
    s.customer.phone ? `Tel ${s.customer.phone}` : "",
    [s.customer.tin ? `TIN ${s.customer.tin}` : "", s.customer.vat_number ? `VRN ${s.customer.vat_number}` : ""].filter(Boolean).join("    "),
  ].filter(Boolean).forEach((r, i) => pdf.textFit(L + 9, ci - 29 - i * 11.5, r, bw - 18, 8.5, "regular", i === 0 ? C.muted : C.text));
  const di = panel(pdf, L + bw + 12, y, bw, h, "Details");
  kvRows(pdf, L + bw + 12, di, bw, [
    ["Date", fmtDate(s.document_date)], ["Due date", fmtDate(s.due_date)], ["Branch", s.branch.name],
    ["Customer reference", s.customer_reference ?? "-"], ["Approved", s.approved_by ? `${s.approved_by}, ${fmtDate(s.approved_at)}` : "-"],
  ]);
  return y - h - 16;
}

export function renderSaleInvoice(s: SaleDocData): Uint8Array {
  const pdf = brandedPdf();
  const title = "TAX INVOICE";
  const top = () => header(pdf, s.company, title, s.document_number, `Issued ${fmtDate(s.document_date)}`);
  let y = parties(pdf, s, top(), "Bill to");

  const cols: Col[] = [
    { h: "#", x: L + 8, w: 16 }, { h: "Description", x: L + 28, w: 210 },
    { h: "Qty", x: R - 230, w: 50, right: true }, { h: "Price", x: R - 162, w: 70, right: true },
    { h: "Disc", x: R - 98, w: 56, right: true }, { h: "Amount", x: R - 8, w: 80, right: true },
  ];
  y = table(pdf, y, cols, s.lines.map((l, i) => [String(i + 1), `${l.description}${l.tax_name ? ` (${l.tax_name})` : ""}`, qty(l.quantity), money(l.unit_price), money(l.discount), money(l.line_total)]), top);

  // Totals panel on the right, payment summary on the left
  y -= 10;
  const tw = 220, tx = R - tw;
  const rows: [string, number, boolean][] = [
    ["Subtotal", s.subtotal, false], ["Discount", s.discount_total, false], ["Net", s.net_total, false], ["Tax (VAT)", s.tax_total, false],
  ];
  rows.forEach(([k, v], i) => {
    pdf.text(tx + 9, y - 12 - i * 14, k, 8.5, "regular", C.muted);
    pdf.textRight(R - 9, y - 12 - i * 14, money(v), 9, "regular", C.text);
  });
  let ty = y - 12 - rows.length * 14 + 4;
  pdf.fillRect(tx, ty - 22, tw, 22, C.green);
  pdf.text(tx + 9, ty - 14.5, "TOTAL (TZS)", 9, "bold", C.leaf);
  pdf.textRight(R - 9, ty - 15, money(s.grand_total), 11, "bold", C.white);
  ty -= 36;
  pdf.text(tx + 9, ty, "Paid", 8.5, "regular", C.muted); pdf.textRight(R - 9, ty, money(s.amount_paid), 9, "regular", C.text);
  ty -= 14;
  pdf.text(tx + 9, ty, "Balance due", 9, "bold", C.green); pdf.textRight(R - 9, ty, money(s.outstanding), 10, "bold", C.green);
  if (s.payments.length) {
    const pi = panel(pdf, L, y, W - tw - 16, 20 + s.payments.length * 13, "Payment received");
    s.payments.forEach((p, i) => {
      pdf.textFit(L + 9, pi - 12 - i * 13, p.account, W - tw - 120, 8.5, "regular", C.text);
      pdf.textRight(L + W - tw - 25, pi - 12 - i * 13, money(p.amount), 8.5, "bold", C.text);
    });
  }
  y = Math.min(ty, y - 36 - s.payments.length * 13) - 18;

  signatures(pdf, y, ["Issued by", "Customer"], top);
  finish(pdf, s.company, `${title}  ${s.document_number}`, "Thank you for your business.");
  return pdf.toBytes({ title: `Invoice ${s.document_number}` });
}

export function renderSaleDeliveryNote(s: SaleDocData): Uint8Array {
  const pdf = brandedPdf();
  const title = "DELIVERY NOTE";
  const top = () => header(pdf, s.company, title, s.document_number, `For invoice ${s.document_number}  -  ${fmtDate(s.document_date)}`);
  let y = parties(pdf, s, top(), "Deliver to");

  pdf.text(L, y, "GOODS", 8, "bold", C.green);
  y -= 8;
  const cols: Col[] = [
    { h: "#", x: L + 8, w: 16 }, { h: "SKU", x: L + 28, w: 84 }, { h: "Description", x: L + 116, w: 260 },
    { h: "Quantity", x: R - 70, w: 70, right: true }, { h: "Unit", x: R - 56, w: 48 },
  ];
  const total = s.lines.reduce((a, l) => a + Number(l.quantity), 0);
  y = table(pdf, y, cols, s.lines.map((l, i) => [String(i + 1), l.sku, l.description, qty(l.quantity), l.unit ?? ""]), top, ["", "", "Total quantity", qty(total), ""]);
  y -= 16;

  signatures(pdf, y, ["Issued by (store)", "Delivered by", "Received by (customer)"], top);
  finish(pdf, s.company, `${title}  ${s.document_number}`, "Please check the goods on delivery. Quantities are as invoiced; no prices are shown.");
  return pdf.toBytes({ title: `Delivery note ${s.document_number}` });
}
