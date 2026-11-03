/**
 * Goods Received Note for one supplier's goods on a transfer, issued by Head
 * Office to submit to the supplier. Pure rendering; no prices.
 */
import { brandedPdf, header, panel, kvRows, table, signatures, finish, fmtDate, qty, C, L, R, W, type Col } from "@/lib/pdf/brand";

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

export function renderTransferGrn(g: GrnData): Uint8Array {
  const pdf = brandedPdf();
  const title = "GOODS RECEIVED NOTE";
  const top = () => header(pdf, g.company, title, g.number, `Issued by Head Office  -  ${fmtDate(g.issued_at)}`);
  let y = top();

  // Supplier (left) and document details (right)
  const bw = W / 2 - 6, h = 112;
  const si = panel(pdf, L, y, bw, h, "Supplier");
  const s = g.supplier;
  if (s) {
    pdf.textFit(L + 9, si - 15, s.name, bw - 18, 11, "bold", C.green);
    const rows = [
      `Supplier code: ${s.code}`,
      s.address ?? "",
      [s.contact_person ? `Contact: ${s.contact_person}` : "", s.phone ? `Tel ${s.phone}` : ""].filter(Boolean).join("    "),
      s.email ? `Email: ${s.email}` : "",
      [s.tin ? `TIN ${s.tin}` : "", s.vat_number ? `VRN ${s.vat_number}` : ""].filter(Boolean).join("    "),
      s.payment_terms_days != null ? `Payment terms: ${s.payment_terms_days} days` : "",
    ].filter(Boolean);
    rows.forEach((r, i) => pdf.textFit(L + 9, si - 29 - i * 11.5, r, bw - 18, 8.5, "regular", i === 0 ? C.muted : C.text));
  } else {
    pdf.textFit(L + 9, si - 15, "Supplier not recorded", bw - 18, 11, "bold", C.green);
    pdf.textFit(L + 9, si - 29, "No posted purchase or import was found for these products.", bw - 18, 8.5, "regular", C.muted);
  }
  const di = panel(pdf, L + bw + 12, y, bw, h, "Receipt details");
  kvRows(pdf, L + bw + 12, di, bw, [
    ["GRN date", fmtDate(g.issued_at)], ["Transfer no.", g.transfer.number ?? "Draft"], ["Transfer date", fmtDate(g.transfer.date)],
    ["Delivery note(s)", g.delivery_notes.join(", ")], ["From", `${g.from.code} - ${g.from.name}`],
    ["Received at", `${g.to.code} - ${g.to.name}`], ["Reference", g.transfer.reference ?? "-"],
  ]);
  y -= h + 16;

  pdf.text(L, y, "GOODS", 8, "bold", C.green);
  y -= 8;
  const cols: Col[] = [
    { h: "#", x: L + 8, w: 16 }, { h: "SKU", x: L + 28, w: 70 }, { h: "Description", x: L + 102, w: 168 }, { h: "Batch", x: L + 274, w: 56 },
    { h: "Unit", x: L + 334, w: 36 }, { h: "Sent", x: R - 128, w: 50, right: true }, { h: "Received", x: R - 66, w: 55, right: true }, { h: "Net kg", x: R - 8, w: 55, right: true },
  ];
  const tSent = g.lines.reduce((a, l) => a + l.sent, 0), tRec = g.lines.reduce((a, l) => a + l.received, 0), tKg = g.lines.reduce((a, l) => a + (l.net_kg ?? 0), 0);
  y = table(pdf, y, cols, g.lines.map((ln, i) => [String(i + 1), ln.sku, ln.name, ln.batch ?? "", ln.unit ?? "", qty(ln.sent), qty(ln.received), ln.net_kg == null ? "-" : qty(ln.net_kg)]),
    top, ["", "", "Total", "", "", qty(tSent), qty(tRec), qty(tKg)]);
  y -= 12;
  if (g.transfer.status !== "received") {
    pdf.fillRect(L, y - 18, W, 18, [255, 248, 230], { color: [230, 196, 120], width: 0.6 });
    pdf.textFit(L + 9, y - 12, "The transfer is not fully received yet; Received shows what has been recorded so far.", W - 18, 8.5, "regular", [120, 80, 0]);
    y -= 28;
  }

  signatures(pdf, y - 4, ["Received by (Elements)", "Checked / approved by", "Supplier representative"], top);
  finish(pdf, g.company, `${title}  ${g.number}`, `Goods Received Note for submission to the supplier. Quantities only; no prices. Transfer ${g.transfer.number ?? "draft"}.`);
  return pdf.toBytes({ title: `GRN ${g.number}` });
}
