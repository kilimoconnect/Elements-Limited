import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Transfer Report: stock moved between branches, truck by truck.
 * A truck counts in the period by its dispatch date once loaded, or by the
 * date its order was created while it still waits for loading.
 */
export interface TransferFilters { start: string; end: string; from?: string; to?: string; product?: string; status?: string }

export type TruckStatus = "waiting" | "in_transit" | "arrived" | "received";
export const TRUCK_STATUS: Record<TruckStatus, string> = {
  waiting: "Waiting for loading", in_transit: "In transit", arrived: "Arrived, not yet received", received: "Received",
};

export interface TruckRow {
  tripId: string; transferId: string; transfer: string; trip: string; deliveryNote: string | null;
  from: string; to: string; fromId: string; toId: string;
  vehicle: string | null; trailer: string | null; driver: string | null; driverPhone: string | null;
  orderCreated: string; date: string; dispatchedAt: string | null; eta: string | null; arrivedAt: string | null;
  status: TruckStatus; late: boolean; transitHours: number | null;
  loaded: number; received: number; inTransit: number; short: number; damaged: number; lost: number;
  lines: { productId: string; sku: string; product: string; unit: string; loaded: number; received: number; inTransit: number; short: number; damaged: number; lost: number }[];
}

export interface Agg { key: string; label: string; unit?: string; trucks: number; loaded: number; received: number; inTransit: number; short: number; damaged: number; lost: number; onTime: number; timed: number; hours: number; hoursN: number }

export interface TransferReport {
  trucks: TruckRow[];
  orders: number; waiting: number; loadedTrucks: number;
  totals: Omit<Agg, "key" | "label">;
  delayedNow: number; onTimeRate: number | null; avgTransitHours: number | null;
  byRoute: Agg[]; byProduct: Agg[];
}

const N = (v: unknown) => Number(v ?? 0);
const DAR = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 10);

function blank(key: string, label: string, unit?: string): Agg {
  return { key, label, unit, trucks: 0, loaded: 0, received: 0, inTransit: 0, short: 0, damaged: 0, lost: 0, onTime: 0, timed: 0, hours: 0, hoursN: 0 };
}

export async function transferReport(companyId: string, branchIds: string[] | null, f: TransferFilters): Promise<TransferReport> {
  const admin = createAdminClient();
  let q = admin.from("stock_transfer_dispatches")
    .select(`id, trip_no, status, document_number, delivery_note_number, vehicle_registration, trailer_registration, driver_name, driver_phone,
      dispatch_date, dispatched_at, expected_arrival_at, arrived_at, created_at,
      transfer:stock_transfers!inner(id, document_number, status, created_at, source_branch_id, destination_branch_id,
        source:branches!stock_transfers_source_branch_id_fkey(name), dest:branches!stock_transfers_destination_branch_id_fkey(name)),
      lines:stock_transfer_dispatch_lines(qty, qty_reported, qty_accepted, qty_quarantined, qty_short, qty_lost_normal, qty_lost_abnormal,
        line:stock_transfer_lines(product_id, product:products(sku, name, unit:units(symbol))))`)
    .eq("company_id", companyId).neq("status", "voided").neq("transfer.status", "voided")
    .order("created_at", { ascending: false }).limit(5000);
  if (branchIds) {
    const ids = branchIds.length ? branchIds.join(",") : "00000000-0000-0000-0000-000000000000";
    q = q.or(`source_branch_id.in.(${ids}),destination_branch_id.in.(${ids})`, { referencedTable: "transfer" });
  }
  if (f.from) q = q.eq("transfer.source_branch_id", f.from);
  if (f.to) q = q.eq("transfer.destination_branch_id", f.to);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  type Raw = {
    id: string; trip_no: number; status: string; document_number: string | null; delivery_note_number: string | null;
    vehicle_registration: string | null; trailer_registration: string | null; driver_name: string | null; driver_phone: string | null;
    dispatch_date: string; dispatched_at: string | null; expected_arrival_at: string | null; arrived_at: string | null; created_at: string;
    transfer: { id: string; document_number: string | null; status: string; created_at: string; source_branch_id: string; destination_branch_id: string; source: { name: string } | null; dest: { name: string } | null } | null;
    lines: { qty: number; qty_reported: number; qty_accepted: number; qty_quarantined: number; qty_short: number; qty_lost_normal: number; qty_lost_abnormal: number;
      line: { product_id: string; product: { sku: string; name: string; unit: { symbol: string } | null } | null } | null }[];
  };
  const now = Date.now();
  const trucks: TruckRow[] = [];
  for (const r of (data ?? []) as unknown as Raw[]) {
    const t = r.transfer;
    if (!t) continue;
    const waiting = r.status === "draft";
    const date = waiting ? DAR(r.created_at) : r.dispatch_date;
    if (date < f.start || date > f.end) continue;
    const status: TruckStatus = waiting ? "waiting" : r.status === "received" ? "received" : r.arrived_at || r.status === "arrived" ? "arrived" : "in_transit";
    if (f.status && f.status !== status) continue;
    const lines = r.lines.map((l) => {
      const reported = N(l.qty_reported);
      return {
        productId: l.line?.product_id ?? "", sku: l.line?.product?.sku ?? "", product: l.line?.product?.name ?? "", unit: l.line?.product?.unit?.symbol ?? "",
        loaded: waiting ? 0 : N(l.qty), received: N(l.qty_accepted), inTransit: waiting ? 0 : Math.max(N(l.qty) - reported, 0),
        short: N(l.qty_short), damaged: N(l.qty_quarantined), lost: N(l.qty_lost_normal) + N(l.qty_lost_abnormal),
      };
    });
    if (f.product && !lines.some((l) => l.productId === f.product)) continue;
    const shown = f.product ? lines.filter((l) => l.productId === f.product) : lines;
    const sum = (k: "loaded" | "received" | "inTransit" | "short" | "damaged" | "lost") => shown.reduce((a, l) => a + l[k], 0);
    const eta = r.expected_arrival_at;
    const late = !!eta && (r.arrived_at ? new Date(r.arrived_at) > new Date(eta) : status === "in_transit" && new Date(eta).getTime() < now);
    const transitHours = r.dispatched_at && r.arrived_at ? (new Date(r.arrived_at).getTime() - new Date(r.dispatched_at).getTime()) / 3600_000 : null;
    trucks.push({
      tripId: r.id, transferId: t.id, transfer: t.document_number ?? "Order", trip: r.document_number ?? `Trip ${r.trip_no}`, deliveryNote: r.delivery_note_number,
      from: t.source?.name ?? "", to: t.dest?.name ?? "", fromId: t.source_branch_id, toId: t.destination_branch_id,
      vehicle: r.vehicle_registration, trailer: r.trailer_registration, driver: r.driver_name, driverPhone: r.driver_phone,
      orderCreated: t.created_at, date, dispatchedAt: r.dispatched_at, eta, arrivedAt: r.arrived_at, status, late, transitHours,
      loaded: sum("loaded"), received: sum("received"), inTransit: sum("inTransit"), short: sum("short"), damaged: sum("damaged"), lost: sum("lost"),
      lines: shown,
    });
  }

  const add = (a: Agg, x: { loaded: number; received: number; inTransit: number; short: number; damaged: number; lost: number }, tr: TruckRow, countTruck: boolean) => {
    if (countTruck) a.trucks++;
    a.loaded += x.loaded; a.received += x.received; a.inTransit += x.inTransit; a.short += x.short; a.damaged += x.damaged; a.lost += x.lost;
    if (countTruck && tr.arrivedAt && tr.eta) { a.timed++; if (!tr.late) a.onTime++; }
    if (countTruck && tr.transitHours != null) { a.hours += tr.transitHours; a.hoursN++; }
  };
  const total = blank("all", "All");
  const routes = new Map<string, Agg>(), products = new Map<string, Agg>();
  for (const tr of trucks) {
    const loaded = tr.status !== "waiting";
    if (loaded) add(total, tr, tr, true);
    const rk = `${tr.fromId}>${tr.toId}`;
    const ra = routes.get(rk) ?? blank(rk, `${tr.from} → ${tr.to}`);
    if (loaded) add(ra, tr, tr, true);
    routes.set(rk, ra);
    if (!loaded) continue;
    for (const l of tr.lines) {
      const pa = products.get(l.productId) ?? blank(l.productId, `${l.sku} — ${l.product}`, l.unit);
      add(pa, l, tr, true);
      products.set(l.productId, pa);
    }
  }
  const byQty = (a: Agg, b: Agg) => b.loaded - a.loaded;
  return {
    trucks,
    orders: new Set(trucks.map((t) => t.transferId)).size,
    waiting: trucks.filter((t) => t.status === "waiting").length,
    loadedTrucks: total.trucks,
    totals: total,
    delayedNow: trucks.filter((t) => t.status === "in_transit" && t.late).length,
    onTimeRate: total.timed ? total.onTime / total.timed : null,
    avgTransitHours: total.hoursN ? total.hours / total.hoursN : null,
    byRoute: [...routes.values()].sort(byQty),
    byProduct: [...products.values()].sort(byQty),
  };
}
