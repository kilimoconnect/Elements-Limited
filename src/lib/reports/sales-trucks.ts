import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Sales by truck: every dispatched sales truck (collected, delivered, in
 * transit or voided) with its order, customer, crew, documents, cargo and
 * invoice. A truck belongs to the period by its dispatch date (Dar es Salaam).
 */
export interface TruckSalesFilters { start: string; end: string; branch?: string; status?: string; q?: string }

export const TRUCK_SALE_STATUS: Record<string, string> = {
  dispatched: "Dispatched", in_transit: "In transit", delivered: "Delivered", collected: "Collected", voided: "Voided",
};

export interface TruckSaleLine { sku: string; product: string; unit: string; qty: number; accepted: number | null; short: number; damaged: number; unitPrice: number }
export interface TruckSale {
  id: string; truck: string; status: string; mode: "collection" | "delivery"; dispatchedAt: string | null; deliveredAt: string | null;
  branch: string; order: string; orderId: string; customer: string; customerCode: string;
  vehicle: string | null; trailer: string | null; driver: string | null; driverPhone: string | null; receivedBy: string | null;
  loadingOrder: string | null; deliveryNote: string | null; destination: string | null;
  invoice: string | null; invoiceId: string | null; invoiceStatus: string | null;
  net: number; vat: number; total: number; paid: number; outstanding: number; quantity: number;
  lines: TruckSaleLine[]; voidReason: string | null;
}

const N = (v: unknown) => Number(v ?? 0);
const DAR = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 10);

export async function truckSales(companyId: string, branchIds: string[] | null, f: TruckSalesFilters): Promise<TruckSale[]> {
  const admin = createAdminClient();
  // Dispatch dates are timestamps: widen by a day each side, then keep the Dar es Salaam dates in the period.
  const from = new Date(`${f.start}T00:00:00+03:00`).toISOString(), to = new Date(`${f.end}T23:59:59.999+03:00`).toISOString();
  let q = admin.from("sales_shipments")
    .select(`id, document_number, status, dispatched_at, delivered_at, vehicle_registration, trailer_registration, driver_name, driver_phone,
      recipient_name, loading_order_number, delivery_note_number, destination, void_reason, branch_id,
      branch:branches(name), order:sales_orders(id, document_number, fulfilment_mode, customer:customers(code, name)),
      invoice:sales!sales_shipments_invoice_sale_id_fkey(id, document_number, document_status, net_total, tax_total, grand_total, amount_paid, outstanding),
      lines:sales_shipment_lines(qty_dispatched, qty_accepted, qty_short, qty_damaged, order_line:sales_order_lines(unit_price, description, product:products(sku, name, unit:units(code))))`)
    .eq("company_id", companyId).not("dispatched_at", "is", null).gte("dispatched_at", from).lte("dispatched_at", to)
    .order("dispatched_at", { ascending: false }).limit(5000);
  if (branchIds) q = q.in("branch_id", branchIds.length ? branchIds : ["00000000-0000-0000-0000-000000000000"]);
  if (f.branch) q = q.eq("branch_id", f.branch);
  if (f.status) q = q.eq("status", f.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  type Raw = {
    id: string; document_number: string; status: string; dispatched_at: string | null; delivered_at: string | null;
    vehicle_registration: string | null; trailer_registration: string | null; driver_name: string | null; driver_phone: string | null;
    recipient_name: string | null; loading_order_number: string | null; delivery_note_number: string | null; destination: string | null; void_reason: string | null;
    branch: { name: string } | null; order: { id: string; document_number: string; fulfilment_mode: "collection" | "delivery"; customer: { code: string; name: string } | null } | null;
    invoice: { id: string; document_number: string | null; document_status: string; net_total: number; tax_total: number; grand_total: number; amount_paid: number; outstanding: number } | null;
    lines: { qty_dispatched: number; qty_accepted: number | null; qty_short: number | null; qty_damaged: number | null;
      order_line: { unit_price: number; description: string | null; product: { sku: string; name: string; unit: { code: string } | null } | null } | null }[];
  };
  const term = (f.q ?? "").trim().toLowerCase();
  return ((data ?? []) as unknown as Raw[])
    .filter((r) => !r.dispatched_at || (DAR(r.dispatched_at) >= f.start && DAR(r.dispatched_at) <= f.end))
    .map((r): TruckSale => {
      const inv = r.invoice, voided = r.status === "voided" || inv?.document_status === "voided";
      const lines = r.lines.filter((l) => N(l.qty_dispatched) > 0).map((l) => ({
        sku: l.order_line?.product?.sku ?? "", product: l.order_line?.product?.name ?? l.order_line?.description ?? "", unit: l.order_line?.product?.unit?.code ?? "",
        qty: N(l.qty_dispatched), accepted: l.qty_accepted == null ? null : N(l.qty_accepted), short: N(l.qty_short), damaged: N(l.qty_damaged), unitPrice: N(l.order_line?.unit_price),
      }));
      return {
        id: r.id, truck: r.document_number, status: r.status, mode: r.order?.fulfilment_mode ?? "collection", dispatchedAt: r.dispatched_at, deliveredAt: r.delivered_at,
        branch: r.branch?.name ?? "", order: r.order?.document_number ?? "", orderId: r.order?.id ?? "", customer: r.order?.customer?.name ?? "", customerCode: r.order?.customer?.code ?? "",
        vehicle: r.vehicle_registration, trailer: r.trailer_registration, driver: r.driver_name, driverPhone: r.driver_phone, receivedBy: r.recipient_name,
        loadingOrder: r.loading_order_number, deliveryNote: r.delivery_note_number, destination: r.destination,
        invoice: inv?.document_number ?? null, invoiceId: inv?.id ?? null, invoiceStatus: inv?.document_status ?? null,
        // A voided truck adds nothing to the totals.
        net: voided ? 0 : N(inv?.net_total), vat: voided ? 0 : N(inv?.tax_total), total: voided ? 0 : N(inv?.grand_total),
        paid: voided ? 0 : N(inv?.amount_paid), outstanding: voided ? 0 : N(inv?.outstanding),
        quantity: voided ? 0 : lines.reduce((a, l) => a + l.qty, 0), lines, voidReason: r.void_reason,
      };
    })
    .filter((t) => !term || [t.truck, t.vehicle, t.trailer, t.driver, t.customer, t.order, t.invoice, t.deliveryNote].some((v) => (v ?? "").toLowerCase().includes(term)));
}

export function truckTotals(rows: TruckSale[]) {
  const live = rows.filter((r) => r.status !== "voided");
  return {
    trucks: live.length, voided: rows.length - live.length,
    quantity: live.reduce((a, r) => a + r.quantity, 0), net: live.reduce((a, r) => a + r.net, 0), vat: live.reduce((a, r) => a + r.vat, 0),
    total: live.reduce((a, r) => a + r.total, 0), paid: live.reduce((a, r) => a + r.paid, 0), outstanding: live.reduce((a, r) => a + r.outstanding, 0),
  };
}

/** Sales filters from a URL (page and export links share them). */
export function truckFiltersFrom(sp: URLSearchParams | Record<string, string | string[] | undefined>, defaults: { start: string; end: string }): TruckSalesFilters {
  const get = (k: string) => (sp instanceof URLSearchParams ? sp.get(k) ?? "" : typeof sp[k] === "string" ? (sp[k] as string) : "");
  const d = (v: string, def: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : def);
  return { start: d(get("start"), defaults.start), end: d(get("end"), defaults.end), branch: get("branch"), status: get("status"), q: get("q") };
}
