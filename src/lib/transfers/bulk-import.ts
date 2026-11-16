/**
 * Bulk transfer orders from an Excel / CSV file: one row per product on a
 * truck. Rows with the same receiving branch and truck make one transfer
 * order (one truck). A row that leaves "To branch" and "Truck registration"
 * empty continues the truck above it.
 */
import { normaliseRegistration } from "@/lib/transfers/registration";
import { normalisePhone } from "@/lib/phone";

export const IMPORT_COLUMNS = [
  "To branch", "Truck registration", "Trailer registration", "Driver name", "Driver phone",
  "Driver licence", "Transporter", "Transporter contact", "Product", "Quantity",
] as const;

export interface RawImportRow { row: number; values: string[] }
export interface ImportBranch { id: string; code: string; name: string }
export interface ImportProduct { id: string; sku: string; name: string }

export interface ImportLine { row: number; productId: string; product: string; qty: number }
export interface ImportOrder {
  key: string; rows: number[]; toBranchId: string; toBranch: string;
  vehicle: string; trailer: string; driverName: string; driverPhone: string; driverLicence: string;
  transporter: string; transporterContact: string; lines: ImportLine[];
}
export interface ImportIssue { row: number; message: string }
export interface ImportCheck { orders: ImportOrder[]; errors: ImportIssue[]; warnings: ImportIssue[] }

const clean = (v: string | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
const key = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Header positions, tolerant of case, spaces and an asterisk on required columns. */
export function headerIndex(header: string[]): Record<string, number> | null {
  const pos: Record<string, number> = {};
  header.forEach((h, i) => { const k = key(h); if (k && pos[k] === undefined) pos[k] = i; });
  const out: Record<string, number> = {};
  for (const c of IMPORT_COLUMNS) {
    const i = pos[key(c)];
    if (i === undefined && ["To branch", "Truck registration", "Product", "Quantity"].includes(c)) return null;
    out[c] = i ?? -1;
  }
  return out;
}

export function matchBranch(text: string, branches: ImportBranch[]): ImportBranch | null {
  const k = key(text);
  if (!k) return null;
  return branches.find((b) => key(b.name) === k || key(b.code) === k || key(`${b.name} (${b.code})`) === k || key(`${b.code} — ${b.name}`) === k) ?? null;
}

export function matchProduct(text: string, products: ImportProduct[]): ImportProduct | null {
  const k = key(text);
  if (!k) return null;
  return products.find((p) => key(p.sku) === k || key(`${p.sku} — ${p.name}`) === k || key(`${p.sku} ${p.name}`) === k)
    ?? products.find((p) => key(p.name) === k)
    // "PRD-0002 — AMMONIUM ..." typed with another dash: the SKU before the first separator.
    ?? products.find((p) => key(text.split(/\s[—–-]\s/)[0] ?? "") === key(p.sku))
    ?? null;
}

/** Parse a quantity: "1,200", "1 200", "1200.5". */
export function parseQty(text: string): number {
  const t = clean(text).replace(/[\s,]/g, "");
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/** Turn file rows into transfer orders (one per receiving branch + truck), with row-level errors. */
export function buildOrders(rows: RawImportRow[], header: string[], branches: ImportBranch[], products: ImportProduct[], sourceBranchId: string): ImportCheck {
  const errors: ImportIssue[] = [], warnings: ImportIssue[] = [];
  const idx = headerIndex(header);
  if (!idx) return { orders: [], errors: [{ row: 1, message: `The file needs the columns: ${IMPORT_COLUMNS.join(", ")}. Download the template.` }], warnings };
  const get = (r: RawImportRow, c: (typeof IMPORT_COLUMNS)[number]) => (idx[c] >= 0 ? clean(r.values[idx[c]]) : "");
  const orders = new Map<string, ImportOrder>();
  let prev: ImportOrder | null = null;
  for (const r of rows) {
    const toText = get(r, "To branch"), truckText = get(r, "Truck registration"), productText = get(r, "Product"), qtyText = get(r, "Quantity");
    if (![toText, truckText, productText, qtyText, get(r, "Driver name")].some(Boolean)) continue; // empty row
    let order: ImportOrder | null = null;
    if (!toText && !truckText) {
      if (!prev) { errors.push({ row: r.row, message: "Enter the receiving branch and the truck registration." }); continue; }
      order = prev; // continues the truck above
    } else {
      const to = matchBranch(toText, branches);
      const vehicle = normaliseRegistration(truckText);
      if (!toText) { errors.push({ row: r.row, message: "Enter the receiving branch (To branch)." }); continue; }
      if (!to) { errors.push({ row: r.row, message: `Branch "${toText}" is not a branch in the system. Choose one from the list.` }); continue; }
      if (to.id === sourceBranchId) { errors.push({ row: r.row, message: `${to.name} is the sending branch; choose another receiving branch.` }); continue; }
      if (!vehicle) { errors.push({ row: r.row, message: "Enter the truck registration." }); continue; }
      const k = `${to.id}|${vehicle}`;
      order = orders.get(k) ?? null;
      const fields = {
        trailer: normaliseRegistration(get(r, "Trailer registration")), driverName: get(r, "Driver name"), driverPhone: normalisePhone(get(r, "Driver phone")),
        driverLicence: get(r, "Driver licence"), transporter: get(r, "Transporter"), transporterContact: normalisePhone(get(r, "Transporter contact")),
      };
      if (!order) {
        order = { key: k, rows: [], toBranchId: to.id, toBranch: to.name, vehicle, lines: [], ...fields };
        orders.set(k, order);
      } else {
        // Same truck on more rows: fill in details given only on a later row.
        for (const [f, v] of Object.entries(fields) as [keyof typeof fields, string][]) if (!order[f] && v) order[f] = v;
      }
    }
    prev = order;
    const product = matchProduct(productText, products);
    const qty = parseQty(qtyText);
    if (!productText) { errors.push({ row: r.row, message: "Enter the product." }); continue; }
    if (!product) { errors.push({ row: r.row, message: `Product "${productText}" was not found. Choose one from the list.` }); continue; }
    if (!(qty > 0)) { errors.push({ row: r.row, message: `Quantity "${qtyText}" must be a number above zero.` }); continue; }
    order.rows.push(r.row);
    const same = order.lines.find((l) => l.productId === product.id);
    if (same) same.qty += qty;
    else order.lines.push({ row: r.row, productId: product.id, product: `${product.sku} — ${product.name}`, qty });
  }
  const list = [...orders.values()].filter((o) => o.lines.length > 0);
  for (const o of list) if (!o.driverName) errors.push({ row: o.rows[0], message: `Truck ${o.vehicle}: enter the driver's name.` });
  // One truck cannot go to two branches at once.
  const byTruck = new Map<string, ImportOrder[]>();
  for (const o of list) byTruck.set(o.vehicle, [...(byTruck.get(o.vehicle) ?? []), o]);
  for (const [v, os] of byTruck) if (os.length > 1) errors.push({ row: os[1].rows[0], message: `Truck ${v} appears for ${os.map((o) => o.toBranch).join(" and ")}. One truck goes to one branch.` });
  return { orders: list, errors: errors.sort((a, b) => a.row - b.row), warnings };
}

/** Very small CSV reader (quotes, commas, semicolons, new lines inside quotes). */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const firstLine = t.split(/\r?\n/, 1)[0] ?? "";
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === "\"") { if (t[i + 1] === "\"") { cell += "\""; i++; } else q = false; }
      else cell += c;
    } else if (c === "\"") q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  // Excel's ="0712..." text trick.
  return rows.map((r) => r.map((v) => v.replace(/^="(.*)"$/, "$1")));
}
