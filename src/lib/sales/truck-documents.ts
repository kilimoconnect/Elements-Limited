/**
 * Per-truck documents (Loading Order, Delivery Note, Commercial Invoice),
 * rendered only from the snapshot stored when the document was finalised
 * (document_versions). Reprinting reads the same snapshot: nothing is
 * recomputed or posted.
 */
import { brandedPdf, header, panel, kvRows, table, signatures, finish, fmtDate, fmtLongDate, qty, money, wrapText, BOTTOM, C, L, R, W, type Col } from "@/lib/pdf/brand";
import { amountInWords } from "@/lib/pdf/amount-words";
import type { SimplePdf } from "@/lib/pdf/simple-pdf";

export type TruckDocKind = "loading_order" | "delivery_note" | "commercial_invoice";

export interface TruckSnapshot {
  kind: TruckDocKind;
  company: { name: string; legal_name: string | null; address: string | null; phone: string | null; email: string | null };
  branch: { code: string; name: string; address: string | null; phone: string | null };
  order: { number: string; approved_at: string; approved_by: string | null; request_number: string | null; fulfilment_mode: "collection" | "delivery" };
  shipment: { number: string; loading_order_number: string | null; delivery_note_number: string | null; dispatch_location: string | null;
    planned_loading_date: string | null; planned_dispatch_date: string | null; loading_order_at: string | null; dispatched_at: string | null;
    prepared_by: string | null; dispatched_by: string | null };
  customer: { code: string; name: string; address: string | null; phone: string | null; tin: string | null; vat_number: string | null; contact_name: string | null; contact_phone: string | null };
  consignee: { name: string | null; phone: string | null; destination: string | null };
  transport: { transporter: string | null; transporter_contact: string | null; driver: string | null; driver_phone: string | null; driver_licence: string | null;
    vehicle: string | null; trailer: string | null; collector: string | null; collector_phone: string | null; collector_id: string | null };
  lines: { sku: string; name: string; unit: string | null; qty: number; kg_per_unit: number | null; batch: string | null; is_free: boolean }[];
  invoice?: { number: string; date: string; subtotal: number; discount_total: number; net_total: number; tax_total: number; grand_total: number;
    amount_paid: number; outstanding: number; order_total: number;
    lines: { description: string; sku: string; qty: number; unit_price: number; discount: number; tax_name: string | null; net: number; tax: number; total: number }[];
    payments: { receipt: string; reference: string | null; method: string | null; amount: number }[] } | null;
}

const join = (...p: (string | null | undefined)[]) => p.filter((x) => x && String(x).trim()).join(", ");

function parties(pdf: SimplePdf, s: TruckSnapshot, y: number, left: string): number {
  const bw = W / 2 - 6, h = 96;
  const ci = panel(pdf, L, y, bw, h, left);
  const delivery = s.order.fulfilment_mode === "delivery";
  pdf.textFit(L + 9, ci - 15, s.customer.name, bw - 18, 11, "bold", C.green);
  [
    `Customer ${s.customer.code}${s.customer.tin ? `  ·  TIN ${s.customer.tin}` : ""}${s.customer.vat_number ? `  ·  VRN ${s.customer.vat_number}` : ""}`,
    s.customer.address ?? "",
    join(s.customer.contact_name, s.customer.contact_phone ?? s.customer.phone),
    delivery ? `Deliver to: ${join(s.consignee.destination)}` : "Collection by the customer",
    delivery ? `Consignee: ${join(s.consignee.name, s.consignee.phone) || "-"}` : `Collector: ${join(s.transport.collector, s.transport.collector_phone, s.transport.collector_id && `ID ${s.transport.collector_id}`) || "-"}`,
  ].filter(Boolean).forEach((r, i) => pdf.textFit(L + 9, ci - 29 - i * 11.5, r, bw - 18, 8.5, "regular", i === 0 ? C.muted : C.text));
  const di = panel(pdf, L + bw + 12, y, bw, h, "Order and truck");
  kvRows(pdf, L + bw + 12, di, bw, [
    ["Sales order", s.order.number], ["Approved", `${s.order.approved_by ?? "-"}, ${fmtDate(s.order.approved_at)}`],
    ["Truck", s.shipment.number], ["Vehicle", join(s.transport.vehicle, s.transport.trailer) || "-"],
    ["Driver", join(s.transport.driver, s.transport.driver_phone) || "-"], ["Licence", s.transport.driver_licence ?? "-"],
  ]);
  return y - h - 16;
}

function goods(pdf: SimplePdf, s: TruckSnapshot, y: number, top: () => number): number {
  pdf.text(L, y, "GOODS", 8, "bold", C.green);
  y -= 8;
  const cols: Col[] = [
    { h: "#", x: L + 8, w: 16 }, { h: "SKU", x: L + 28, w: 70 }, { h: "Description", x: L + 102, w: 180 }, { h: "Batch", x: L + 286, w: 60 },
    { h: "Quantity", x: R - 112, w: 60, right: true }, { h: "Unit", x: R - 106, w: 36 }, { h: "Tonnes", x: R - 8, w: 56, right: true },
  ];
  const mt = (l: TruckSnapshot["lines"][number]) => (l.kg_per_unit ? (Number(l.qty) * Number(l.kg_per_unit)) / 1000 : null);
  const totalQ = s.lines.reduce((a, l) => a + Number(l.qty), 0);
  const totalT = s.lines.reduce((a, l) => a + (mt(l) ?? 0), 0);
  return table(pdf, y, cols, s.lines.map((l, i) => [String(i + 1), l.sku, `${l.name}${l.is_free ? " (free)" : ""}`, l.batch ?? "", qty(l.qty), l.unit ?? "",
    mt(l) === null ? "-" : qty(Math.round(mt(l)! * 1000) / 1000)]), top, ["", "", "Total", "", qty(totalQ), "", qty(Math.round(totalT * 1000) / 1000)]);
}

export function renderTruckDocument(s: TruckSnapshot): Uint8Array {
  const pdf = brandedPdf();
  if (s.kind === "loading_order") {
    const no = s.shipment.loading_order_number ?? s.shipment.number;
    const top = () => header(pdf, s.company, "LOADING ORDER", no, fmtLongDate(s.shipment.loading_order_at));
    let y = parties(pdf, s, top(), s.order.fulfilment_mode === "delivery" ? "Customer / delivery" : "Customer / collection");
    pdf.textFit(L, y, `Load at: ${s.shipment.dispatch_location ?? s.branch.name}   ·   Planned loading ${fmtDate(s.shipment.planned_loading_date)}   ·   Planned dispatch ${fmtDate(s.shipment.planned_dispatch_date)}`, W, 8.5, "regular", C.text);
    y = goods(pdf, s, y - 14, top) - 16;
    signatures(pdf, y, ["Issued by (sales)", "Loaded by (store)", "Driver / collector"], top);
    finish(pdf, s.company, `LOADING ORDER  ${no}`, "Load exactly the quantities above. Record the actual quantity loaded before dispatch. This is not an invoice.");
    return pdf.toBytes({ title: `Loading order ${no}` });
  }
  if (s.kind === "delivery_note") {
    const no = s.shipment.delivery_note_number ?? s.shipment.number;
    const top = () => header(pdf, s.company, "DELIVERY NOTE", no, fmtLongDate(s.shipment.dispatched_at));
    let y = parties(pdf, s, top(), s.order.fulfilment_mode === "delivery" ? "Deliver to" : "Collected by");
    pdf.textFit(L, y, `Dispatched from ${s.shipment.dispatch_location ?? s.branch.name} on ${fmtDate(s.shipment.dispatched_at)} by ${s.shipment.dispatched_by ?? "-"}   ·   Loading order ${s.shipment.loading_order_number ?? "-"}`, W, 8.5, "regular", C.text);
    y = goods(pdf, s, y - 14, top) - 16;
    signatures(pdf, y, s.order.fulfilment_mode === "delivery"
      ? ["Dispatched by (store)", "Driver", "Received by (customer)"]
      : ["Dispatched by (store)", "Collector"], top);
    finish(pdf, s.company, `DELIVERY NOTE  ${no}`, "Check the goods on receipt. Note any shortage or damage on this note before signing. No prices are shown.");
    return pdf.toBytes({ title: `Delivery note ${no}` });
  }
  const inv = s.invoice!;
  const top = () => header(pdf, s.company, "COMMERCIAL INVOICE", inv.number, fmtLongDate(inv.date));
  let y = parties(pdf, s, top(), "Bill to");
  for (const ln of wrapText(`Truck ${s.shipment.number}  ·  Delivery note ${s.shipment.delivery_note_number ?? "-"}  ·  Part of sales order ${s.order.number} (order value TZS ${money(inv.order_total)})`, W, 8.5)) {
    pdf.text(L, y, ln, 8.5, "regular", C.text); y -= 11;
  }
  y -= 3;
  const cols: Col[] = [
    { h: "#", x: L + 8, w: 16 }, { h: "Description", x: L + 28, w: 200 }, { h: "Qty", x: R - 236, w: 54, right: true },
    { h: "Price", x: R - 166, w: 66, right: true }, { h: "VAT", x: R - 92, w: 60, right: true }, { h: "Amount", x: R - 8, w: 76, right: true },
  ];
  y = table(pdf, y, cols, inv.lines.map((l, i) => [String(i + 1), `${l.description}${l.tax_name ? ` (${l.tax_name})` : ""}`, qty(l.qty), money(l.unit_price), money(l.tax), money(l.total)]), top);
  y -= 10;
  const tw = 220, tx = R - tw;
  const rows: [string, number][] = [["Subtotal", inv.subtotal], ["Discount", inv.discount_total], ["Net", inv.net_total], ["VAT", inv.tax_total]];
  rows.forEach(([k, v], i) => { pdf.text(tx + 9, y - 12 - i * 14, k, 8.5, "regular", C.muted); pdf.textRight(R - 9, y - 12 - i * 14, money(v), 9, "regular", C.text); });
  let ty = y - 12 - rows.length * 14 + 4;
  pdf.fillRect(tx, ty - 22, tw, 22, C.green);
  pdf.text(tx + 9, ty - 14.5, "TOTAL (TZS)", 9, "bold", C.leaf);
  pdf.textRight(R - 9, ty - 15, money(inv.grand_total), 11, "bold", C.white);
  ty -= 36;
  pdf.text(tx + 9, ty, "Paid from customer advance", 8.5, "regular", C.muted); pdf.textRight(R - 9, ty, money(inv.amount_paid), 9, "regular", C.text);
  ty -= 14;
  pdf.text(tx + 9, ty, "Balance due", 9, "bold", C.green); pdf.textRight(R - 9, ty, money(inv.outstanding), 10, "bold", C.green);
  if (inv.payments.length) {
    const pw = W - tw - 16;
    const pi = panel(pdf, L, y, pw, 20 + inv.payments.length * 13, "Payments applied");
    inv.payments.forEach((p, i) => {
      pdf.textFit(L + 9, pi - 12 - i * 13, `${p.receipt}${p.reference ? `  ·  ${p.reference}` : ""}`, pw - 100, 8.5, "regular", C.text);
      pdf.textRight(L + pw - 9, pi - 12 - i * 13, money(p.amount), 8.5, "bold", C.text);
    });
  }
  y = Math.min(ty, y - 36 - inv.payments.length * 13) - 18;
  // The invoice value in words as well as in figures.
  const words = wrapText(`${amountInWords(inv.grand_total)}  (TZS ${money(inv.grand_total)})`, W - 18, 9, "bold");
  const wh = 18 + words.length * 12;
  if (y - wh < BOTTOM + 30) { pdf.addPage(); y = top(); }
  const wi = panel(pdf, L, y, W, wh + 4, "Amount in words");
  words.forEach((t, i) => pdf.text(L + 9, wi - 14 - i * 12, t, 9, "bold", C.green));
  y -= wh + 14;
  finish(pdf, s.company, `COMMERCIAL INVOICE  ${inv.number}`, "This invoice covers the goods on this truck only. Thank you for your business.");
  return pdf.toBytes({ title: `Commercial invoice ${inv.number}` });
}
