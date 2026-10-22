/**
 * Printable delivery note for one transfer trip, rendered from the stored
 * snapshot of a delivery-note version (document_versions). Pure: no database,
 * no costs, no licence numbers. Producing it posts nothing.
 */
import { A4, SimplePdf, textWidth } from "@/lib/pdf/simple-pdf";

export interface DeliveryNoteSnapshot {
  company: { name: string; legal_name: string | null; address: string | null; phone: string | null; email: string | null };
  transfer_number: string | null; reference: string; trip_no: number; status: string;
  transfer_date: string; dispatch_date: string; dispatched_at: string | null; expected_arrival_at: string | null;
  sender: { code: string; name: string; address: string | null; phone: string | null; location: string | null };
  receiver: { code: string; name: string; address: string | null; phone: string | null; location: string | null };
  driver: { name: string | null; phone: string | null };
  vehicle: { registration: string | null; trailer: string | null };
  transporter: { name: string | null; contact: string | null };
  agents: { name: string; company: string | null; phone: string | null; role: string | null }[];
  lines: { sku: string; name: string; unit: string | null; qty: number; net_kg: number | null; batch: string | null }[];
  notes: string | null;
}

const TZ = "Africa/Dar_es_Salaam";
function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }
  const dt = new Date(iso);
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(dt).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
const qty = (n: number) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 });

export function renderDeliveryNote(s: DeliveryNoteSnapshot, v: { version: number; sha256: string; issuedAt: string }): Uint8Array {
  const pdf = new SimplePdf();
  const L = 40, R = A4.width - 40, W = R - L;
  let y = A4.height - 50;

  const header = () => {
    y = A4.height - 50;
    pdf.text(L, y, s.company.legal_name || s.company.name, 15, "bold");
    pdf.textRight(R, y, "DELIVERY NOTE", 15, "bold");
    y -= 14;
    const contact = [s.company.address, s.company.phone, s.company.email].filter(Boolean).join("  |  ");
    if (contact) pdf.textFit(L, y, contact, W * 0.62, 8);
    pdf.textRight(R, y, `${s.reference}   (version ${v.version})`, 10, "bold");
    y -= 8;
    pdf.line(L, y, R, y, 1);
    y -= 16;
  };
  header();

  // Document references and dates
  const kv = (x: number, label: string, value: string, w = 120) => { pdf.text(x, y, label, 7.5); pdf.textFit(x, y - 10, value || "-", w, 9.5, "bold"); };
  kv(L, "Delivery note ref.", s.reference);
  kv(L + 130, "Transfer no.", s.transfer_number ?? "-");
  kv(L + 240, "Trip", String(s.trip_no), 60);
  kv(L + 300, "Dispatch date", fmtDate(s.dispatch_date), 110);
  kv(L + 415, "Expected arrival", fmtDate(s.expected_arrival_at), 100);
  y -= 30;

  // Sender / receiver
  const box = (x: number, title: string, b: DeliveryNoteSnapshot["sender"]) => {
    const h = 62;
    pdf.rect(x, y - h, W / 2 - 6, h);
    pdf.text(x + 6, y - 12, title, 7.5, "bold");
    pdf.textFit(x + 6, y - 25, `${b.code} - ${b.name}`, W / 2 - 18, 10, "bold");
    pdf.textFit(x + 6, y - 37, b.address ?? "", W / 2 - 18, 8.5);
    pdf.textFit(x + 6, y - 48, [b.location ? `Warehouse: ${b.location}` : "", b.phone ? `Tel ${b.phone}` : ""].filter(Boolean).join("   "), W / 2 - 18, 8.5);
  };
  box(L, "FROM (SENDING BRANCH)", s.sender);
  box(L + W / 2 + 6, "TO (RECEIVING BRANCH)", s.receiver);
  y -= 76;

  // Transport
  pdf.text(L, y, "TRANSPORT", 8, "bold"); y -= 13;
  const t1 = [`Driver: ${s.driver.name ?? "-"}`, `Phone: ${s.driver.phone ?? "-"}`, `Vehicle: ${s.vehicle.registration ?? "-"}`, `Trailer: ${s.vehicle.trailer ?? "-"}`];
  t1.forEach((t, i) => pdf.textFit(L + i * (W / 4), y, t, W / 4 - 6, 9));
  y -= 13;
  pdf.textFit(L, y, `Transporter: ${s.transporter.name ?? "-"}${s.transporter.contact ? `  (${s.transporter.contact})` : ""}`, W, 9);
  y -= 13;
  for (const a of s.agents) {
    pdf.textFit(L, y, `Agent${a.role ? ` (${a.role})` : ""}: ${a.name}${a.company ? `, ${a.company}` : ""}${a.phone ? `  Tel ${a.phone}` : ""}`, W, 9);
    y -= 12;
  }
  y -= 6;

  // Cargo table
  const cols = [
    { h: "#", x: L + 4, w: 18 }, { h: "SKU", x: L + 24, w: 70 }, { h: "Description", x: L + 98, w: 190 }, { h: "Batch", x: L + 292, w: 70 },
    { h: "Quantity", x: R - 150, w: 60, right: true }, { h: "Unit", x: R - 84, w: 40 }, { h: "Net kg", x: R - 4, w: 70, right: true },
  ];
  const tableHead = () => {
    pdf.rect(L, y - 16, W, 16, 0.5, 0.9);
    cols.forEach((c) => (c.right ? pdf.textRight(c.x, y - 11, c.h, 8.5, "bold") : pdf.text(c.x, y - 11, c.h, 8.5, "bold")));
    y -= 16;
  };
  tableHead();
  let totalQty = 0, totalKg = 0;
  s.lines.forEach((ln, i) => {
    if (y < 190) {
      pdf.text(L, 40, `${s.reference} v${v.version} - continued`, 7.5);
      pdf.addPage(); header(); tableHead();
    }
    const row = [String(i + 1), ln.sku, ln.name, ln.batch ?? "", qty(ln.qty), ln.unit ?? "", ln.net_kg == null ? "-" : qty(ln.net_kg)];
    cols.forEach((c, j) => (c.right ? pdf.textRight(c.x, y - 12, row[j], 9) : pdf.textFit(c.x, y - 12, row[j], c.w, 9)));
    pdf.line(L, y - 17, R, y - 17, 0.3);
    y -= 17;
    totalQty += Number(ln.qty); totalKg += Number(ln.net_kg ?? 0);
  });
  pdf.text(L + 98, y - 12, "Total", 9, "bold");
  pdf.textRight(R - 150, y - 12, qty(totalQty), 9, "bold");
  pdf.textRight(R - 4, y - 12, qty(totalKg), 9, "bold");
  y -= 24;
  if (s.notes) { pdf.textFit(L, y, `Notes: ${s.notes}`, W, 9); y -= 16; }

  // Signatures
  if (y < 150) { pdf.addPage(); header(); }
  y = Math.min(y, 160);
  const sigW = W / 3 - 8;
  ["Dispatched by (sender)", "Driver", "Received by (receiver)"].forEach((title, i) => {
    const x = L + i * (sigW + 12);
    pdf.rect(x, y - 92, sigW, 92);
    pdf.text(x + 6, y - 12, title, 8, "bold");
    ["Name", "Signature", "Date / time"].forEach((f, j) => {
      pdf.text(x + 6, y - 34 - j * 22, f, 7.5);
      pdf.line(x + 6 + textWidth(f, 7.5) + 4, y - 35 - j * 22, x + sigW - 6, y - 35 - j * 22, 0.4);
    });
  });
  pdf.text(L, 48, `Issued ${fmtDate(v.issuedAt)} - ${s.reference} version ${v.version} - content ${v.sha256.slice(0, 12)}`, 7);
  pdf.text(L, 38, "Quantities are as dispatched. This note does not move stock; the receiving branch records what arrives.", 7);
  return pdf.toBytes({ title: `Delivery note ${s.reference} v${v.version}` });
}
