/**
 * Printable delivery note for one transfer trip, rendered from the stored
 * snapshot of a delivery-note version (document_versions). Pure: no database,
 * no costs, no licence numbers, no supplier. Producing it posts nothing.
 */
import { brandedPdf, header, panel, kvRows, banner, table, signatures, finish, fmtDate, qty, C, L, R, W, type Col } from "@/lib/pdf/brand";

export interface DeliveryNoteSnapshot {
  company: { name: string; legal_name: string | null; address: string | null; phone: string | null; email: string | null };
  /** Auto-generated delivery note number (null on versions issued before migration 0038). */
  delivery_note_number?: string | null;
  transfer_number: string | null; reference: string; trip_no: number; status: string;
  transfer_date: string; dispatch_date: string; dispatched_at: string | null; expected_arrival_at: string | null;
  sender: { code: string; name: string; address: string | null; phone: string | null; location: string | null };
  receiver: { code: string; name: string; address: string | null; phone: string | null; location: string | null };
  driver: { name: string | null; phone: string | null; licence?: string | null };
  vehicle: { registration: string | null; trailer: string | null };
  transporter: { name: string | null; contact: string | null };
  agents: { name: string; company: string | null; phone: string | null; role: string | null }[];
  lines: { sku: string; name: string; unit: string | null; qty: number; net_kg: number | null; batch: string | null }[];
  notes: string | null;
}

export function renderDeliveryNote(s: DeliveryNoteSnapshot, v: { version: number; sha256: string; issuedAt: string }): Uint8Array {
  const pdf = brandedPdf();
  const dn = s.delivery_note_number || s.reference;
  const title = "DELIVERY NOTE";
  const top = () => header(pdf, s.company, title, dn);
  let y = top();

  y = banner(pdf, y, "GOING TO", `${s.receiver.code} - ${s.receiver.name}${s.receiver.location ? `   (warehouse ${s.receiver.location})` : ""}`);

  // From / To
  const bw = W / 2 - 6, h = 70;
  const branchBox = (x: number, t: string, b: DeliveryNoteSnapshot["sender"]) => {
    const iy = panel(pdf, x, y, bw, h, t);
    pdf.textFit(x + 9, iy - 15, `${b.code} - ${b.name}`, bw - 18, 10.5, "bold", C.green);
    pdf.textFit(x + 9, iy - 28, b.address ?? "", bw - 18, 8.5, "regular", C.text);
    pdf.textFit(x + 9, iy - 40, [b.location ? `Warehouse: ${b.location}` : "", b.phone ? `Tel ${b.phone}` : ""].filter(Boolean).join("    "), bw - 18, 8.5, "regular", C.muted);
  };
  branchBox(L, "From (sending branch)", s.sender);
  branchBox(L + bw + 12, "To (receiving branch)", s.receiver);
  y -= h + 12;

  // Document details / transport
  const dh = 99;
  const di = panel(pdf, L, y, bw, dh, "Document");
  kvRows(pdf, L, di, bw, [
    ["Delivery note no.", dn], ["Transfer no.", s.transfer_number ?? "Draft"], ["Trip", `${s.trip_no}  (${s.reference})`],
    ["Dispatch date", fmtDate(s.dispatch_date)], ["Expected arrival", fmtDate(s.expected_arrival_at)],
  ]);
  const ti = panel(pdf, L + bw + 12, y, bw, dh, "Truck and driver");
  kvRows(pdf, L + bw + 12, ti, bw, [
    ["Truck", s.vehicle.registration ?? "-"], ["Trailer", s.vehicle.trailer ?? "-"], ["Driver", s.driver.name ?? "-"],
    ["Driver phone", s.driver.phone ?? "-"], ["Licence no.", s.driver.licence ?? "-"], ["Transporter", [s.transporter.name, s.transporter.contact].filter(Boolean).join("  ") || "-"],
  ]);
  y -= dh + 10;
  for (const a of s.agents) {
    pdf.textFit(L, y, `Agent${a.role ? ` (${a.role})` : ""}: ${a.name}${a.company ? `, ${a.company}` : ""}${a.phone ? `   Tel ${a.phone}` : ""}`, W, 8.5, "regular", C.text);
    y -= 12;
  }
  y -= 6;

  // Cargo
  pdf.text(L, y, "CARGO", 8, "bold", C.green);
  y -= 8;
  const cols: Col[] = [
    { h: "#", x: L + 8, w: 16 }, { h: "SKU", x: L + 28, w: 72 }, { h: "Description", x: L + 104, w: 200 }, { h: "Batch", x: L + 308, w: 62 },
    { h: "Quantity", x: R - 118, w: 60, right: true }, { h: "Unit", x: R - 108, w: 40 }, { h: "Net kg", x: R - 8, w: 60, right: true },
  ];
  const totalQty = s.lines.reduce((a, l) => a + Number(l.qty), 0);
  const totalKg = s.lines.reduce((a, l) => a + Number(l.net_kg ?? 0), 0);
  y = table(pdf, y, cols, s.lines.map((ln, i) => [String(i + 1), ln.sku, ln.name, ln.batch ?? "", qty(ln.qty), ln.unit ?? "", ln.net_kg == null ? "-" : qty(ln.net_kg)]),
    top, ["", "", "Total", "", qty(totalQty), "", qty(totalKg)]);
  y -= 12;
  if (s.notes) { pdf.textFit(L, y, `Notes: ${s.notes}`, W, 8.5, "regular", C.text); y -= 14; }

  signatures(pdf, y - 4, ["Dispatched by (sender)", "Driver", "Received by (receiver)"], top);
  finish(pdf, s.company, `${title}  ${dn}`);
  return pdf.toBytes({ title: `Delivery note ${dn} v${v.version}` });
}
