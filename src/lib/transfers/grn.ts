/**
 * Goods Received Note for one supplier's goods on a transfer, issued by Head
 * Office to submit to the supplier. Pure rendering; no prices.
 */
import { brandedPdf, header, panel, kvRows, table, signatures, finish, wrapText, fmtLongDate, qty, C, L, R, W, type Col } from "@/lib/pdf/brand";

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
  trucks?: { trip_no: number; truck: string | null; trailer: string | null; driver: string | null; phone: string | null; licence: string | null }[];
  lines: { sku: string; name: string; unit: string | null; batch: string | null; sent: number; received: number; net_kg: number | null }[];
}

export function renderTransferGrn(g: GrnData): Uint8Array {
  const pdf = brandedPdf();
  const title = "GOODS RECEIVED NOTE";
  const top = () => header(pdf, g.company, title, g.number, fmtLongDate(g.issued_at));
  let y = top();

  // Supplier, full width; long values wrap instead of being cut off.
  const s = g.supplier;
  const inner = W - 18;
  const rows: { text: string; muted?: boolean }[] = s ? [
    { text: `Supplier code: ${s.code}`, muted: true },
    ...wrapText(s.address ?? "", inner, 8.5).map((t) => ({ text: t })),
    { text: [s.contact_person ? `Contact: ${s.contact_person}` : "", s.phone ? `Tel ${s.phone}` : ""].filter(Boolean).join("    ") },
    { text: s.email ? `Email: ${s.email}` : "" },
    { text: [s.tin ? `TIN ${s.tin}` : "", s.vat_number ? `VRN ${s.vat_number}` : ""].filter(Boolean).join("    ") },
  ].filter((r) => r.text) : [{ text: "No posted purchase or import was found for these products.", muted: true }];
  const h = 16 + 22 + rows.length * 11.5 + 8;
  const si = panel(pdf, L, y, W, h, "Supplier");
  pdf.textFit(L + 9, si - 15, s ? s.name : "Supplier not recorded", inner, 11, "bold", C.green);
  rows.forEach((r, i) => pdf.textFit(L + 9, si - 29 - i * 11.5, r.text, inner, 8.5, "regular", r.muted ? C.muted : C.text));
  y -= h + 12;

  // Truck and driver, one block per trip (no transporter).
  const trucks = g.trucks ?? [];
  if (trucks.length) {
    const bw = W / 2 - 6, rowH = 13, multi = trucks.length > 1;
    const th = 16 + 8 + trucks.length * (3 * rowH + (multi ? 14 : 0)) + 4;
    const ti = panel(pdf, L, y, W, th, multi ? "Trucks and drivers" : "Truck and driver");
    let ty = ti;
    for (const t of trucks) {
      if (multi) { pdf.text(L + 9, ty - 12, `Trip ${t.trip_no}`, 8, "bold", C.green); ty -= 14; }
      kvRows(pdf, L, ty, bw, [["Truck", t.truck ?? "-"], ["Trailer", t.trailer ?? "-"]]);
      kvRows(pdf, L + bw + 12, ty, bw, [["Driver", t.driver ?? "-"], ["Driver phone", t.phone ?? "-"], ["Licence no.", t.licence ?? "-"]]);
      ty -= 3 * rowH;
    }
    y -= th + 16;
  } else {
    y -= 4;
  }

  pdf.text(L, y, "GOODS", 8, "bold", C.green);
  y -= 8;
  const cols: Col[] = [
    { h: "#", x: L + 8, w: 16 }, { h: "SKU", x: L + 28, w: 70 }, { h: "Description", x: L + 102, w: 168 }, { h: "Batch", x: L + 274, w: 56 },
    { h: "Unit", x: L + 334, w: 36 }, { h: "Qty received", x: R - 78, w: 70, right: true }, { h: "Net kg", x: R - 8, w: 55, right: true },
  ];
  // The goods on the transfer are treated as received from the supplier (one quantity, no "sent" column).
  const tQty = g.lines.reduce((a, l) => a + l.sent, 0), tKg = g.lines.reduce((a, l) => a + (l.net_kg ?? 0), 0);
  y = table(pdf, y, cols, g.lines.map((ln, i) => [String(i + 1), ln.sku, ln.name, ln.batch ?? "", ln.unit ?? "", qty(ln.sent), ln.net_kg == null ? "-" : qty(ln.net_kg)]),
    top, ["", "", "Total", "", "", qty(tQty), qty(tKg)]);
  y -= 16;

  signatures(pdf, y, ["Received by (Elements)", "Supplier representative"], top);
  finish(pdf, g.company, `${title}  ${g.number}`);
  return pdf.toBytes({ title: `GRN ${g.number}` });
}
