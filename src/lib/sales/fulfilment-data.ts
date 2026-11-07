import "server-only";

import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import type { CurrentUser } from "@/lib/auth/session";

type Admin = ReturnType<typeof createAdminClient>;

export const REQUEST_STATUS: Record<string, { label: string; variant: "muted" | "warning" | "destructive" | "success" | "default" }> = {
  draft: { label: "Draft", variant: "muted" },
  pending_approval: { label: "Awaiting approval", variant: "warning" },
  returned: { label: "Returned for correction", variant: "destructive" },
  rejected: { label: "Rejected", variant: "destructive" },
  converted: { label: "Approved", variant: "success" },
};
export const ORDER_STATUS: Record<string, { label: string; variant: "muted" | "warning" | "destructive" | "success" | "default" }> = {
  approved: { label: "Approved", variant: "default" },
  in_fulfilment: { label: "In fulfilment", variant: "warning" },
  completed: { label: "Completed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "muted" },
};
export const SHIPMENT_STATUS: Record<string, { label: string; variant: "muted" | "warning" | "destructive" | "success" | "default" }> = {
  planned: { label: "Planned", variant: "muted" },
  loading_order_issued: { label: "Loading order issued", variant: "default" },
  loaded: { label: "Loaded", variant: "warning" },
  dispatched: { label: "Dispatched", variant: "warning" },
  in_transit: { label: "In transit", variant: "warning" },
  delivered: { label: "Delivered", variant: "success" },
  collected: { label: "Collected", variant: "success" },
  cancelled: { label: "Cancelled", variant: "muted" },
};
export const EVENT_LABEL: Record<string, string> = {
  submitted: "Submitted", returned: "Returned for correction", rejected: "Rejected", approved: "Approved (payment verified, order created)",
  shipment_created: "Truck planned", loading_order: "Loading order issued", loaded: "Actual loading recorded", dispatched: "Dispatched (stock out, invoiced)",
  shipment_cancelled: "Truck cancelled", delivered: "Delivered", collected: "Collected", completed: "Order completed",
  exception_resolved: "Exception resolved", payment_reversed: "Payment reversed", funds_committed: "Funds committed",
  amendment_requested: "Amendment requested", amendment_approved: "Amendment approved", amendment_rejected: "Amendment rejected", cancelled: "Order cancelled", branch_changed: "Branch changed",
};
export const METHOD_LABEL: Record<string, string> = {
  bank_transfer: "Bank transfer", mobile_money: "Mobile money", cash: "Cash", cheque: "Cheque", card: "Card", other: "Other",
};

export function canSeeBranch(user: CurrentUser, branchId: string) {
  return user.isOwner || user.branchIds.includes(branchId);
}

export async function userNames(admin: Admin, ids: (string | null | undefined)[]): Promise<(id: string | null | undefined) => string> {
  const list = [...new Set(ids.filter(Boolean))] as string[];
  const { data } = list.length ? await admin.from("user_profiles").select("id, full_name, email").in("id", list) : { data: [] };
  const m = new Map((data ?? []).map((p) => [p.id, p.full_name || p.email]));
  return (id) => (id ? m.get(id) ?? "—" : "—");
}

export interface TimelineItem { id: string; event_type: string; note: string | null; user_id: string | null; created_at: string; shipment_id: string | null }

export async function loadRequest(admin: Admin, user: CurrentUser, companyId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { data: rq } = await admin.from("sales_requests")
    .select("*, customer:customers(id, code, name, phone), branch:branches(code, name)").eq("id", id).maybeSingle();
  if (!rq || rq.company_id !== companyId || !canSeeBranch(user, rq.branch_id)) notFound();
  const [{ data: lines }, { data: payments }, { data: funds }, { data: events }] = await Promise.all([
    admin.from("sales_request_lines").select("*, product:products(sku, name, track_inventory, unit:units(code))").eq("request_id", id).order("line_no"),
    admin.from("sales_request_payments").select("*, account:payment_accounts(name, code), receipt:customer_receipts(document_number)").eq("request_id", id).order("created_at"),
    admin.from("sales_request_funds").select("*, receipt:customer_receipts(document_number, reference, amount, document_date)").eq("request_id", id),
    admin.from("sales_events").select("id, event_type, note, user_id, created_at, shipment_id").eq("request_id", id).order("created_at"),
  ]);
  return { rq, lines: lines ?? [], payments: payments ?? [], funds: funds ?? [], events: (events ?? []) as TimelineItem[] };
}

export async function loadOrder(admin: Admin, user: CurrentUser, companyId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { data: o } = await admin.from("sales_orders")
    .select("*, customer:customers(id, code, name, phone), branch:branches(code, name), request:sales_requests!sales_orders_request_id_fkey(id, document_number, created_by, submitted_by, submitted_at)")
    .eq("id", id).maybeSingle();
  if (!o || o.company_id !== companyId || !canSeeBranch(user, o.branch_id)) notFound();
  const [{ data: lines }, { data: funds }, { data: shipments }, { data: exceptions }, { data: amendments }, { data: events }] = await Promise.all([
    admin.from("sales_order_lines").select("*, product:products(sku, name, unit:units(code))").eq("order_id", id).order("line_no"),
    admin.from("sales_order_funds").select("*, receipt:customer_receipts(id, document_number, reference, amount, document_status, payment_method, document_date)").eq("order_id", id).order("created_at"),
    admin.from("sales_shipments").select("id, document_number, status, vehicle_registration, driver_name, collector_name, loading_order_number, delivery_note_number, dispatched_at, delivered_at, payment_flag, invoice:sales!sales_shipments_invoice_sale_id_fkey(id, document_number, grand_total, outstanding), lines:sales_shipment_lines(qty_planned, qty_loaded, qty_dispatched, qty_accepted)").eq("order_id", id).order("created_at"),
    admin.from("sales_order_exceptions").select("*").eq("order_id", id).order("raised_at"),
    admin.from("sales_order_amendments").select("*").eq("order_id", id).order("requested_at", { ascending: false }),
    admin.from("sales_events").select("id, event_type, note, user_id, created_at, shipment_id").or(`order_id.eq.${id},request_id.eq.${o.request_id}`).order("created_at"),
  ]);
  const avail: Record<string, number> = {};
  for (const f of funds ?? []) {
    const { data } = await admin.rpc("customer_receipt_available", { p_receipt: f.receipt_id });
    avail[f.receipt_id] = Number(data ?? 0);
  }
  return { o, lines: lines ?? [], funds: funds ?? [], available: avail, shipments: shipments ?? [], exceptions: exceptions ?? [], amendments: amendments ?? [],
    events: (events ?? []) as TimelineItem[] };
}

export async function loadShipment(admin: Admin, user: CurrentUser, companyId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { data: s } = await admin.from("sales_shipments")
    .select("*, order:sales_orders(id, document_number, fulfilment_mode, status, on_hold, hold_reason, customer:customers(code, name)), invoice:sales!sales_shipments_invoice_sale_id_fkey(id, document_number, grand_total, amount_paid, outstanding, payment_status)")
    .eq("id", id).maybeSingle();
  if (!s || s.company_id !== companyId || !canSeeBranch(user, s.branch_id)) notFound();
  const [{ data: lines }, { data: docs }, { data: events }] = await Promise.all([
    admin.from("sales_shipment_lines").select("*, order_line:sales_order_lines(id, line_no, description, quantity, qty_dispatched, qty_allocated, is_free, product:products(sku, name, unit:units(code)))").eq("shipment_id", id),
    admin.from("document_versions").select("id, kind, version, created_at").eq("owner_type", "sales_shipment").eq("owner_id", id).order("version"),
    admin.from("sales_events").select("id, event_type, note, user_id, created_at, shipment_id").eq("shipment_id", id).order("created_at"),
  ]);
  type L = { order_line: { line_no: number } | null };
  const sorted = ((lines ?? []) as L[]).sort((a, b) => (a.order_line?.line_no ?? 0) - (b.order_line?.line_no ?? 0));
  return { s, lines: sorted as typeof lines & object[], docs: docs ?? [], events: (events ?? []) as TimelineItem[] };
}

/** Verified customer money still available (advances not committed, refunded or reversed). */
export async function customerAvailableFunds(admin: Admin, companyId: string, customerId?: string) {
  let q = admin.from("customer_receipts").select("id, customer_id, document_number, reference, amount, document_date, payment_method")
    .eq("company_id", companyId).eq("receipt_kind", "advance").eq("document_status", "posted").order("document_date");
  if (customerId) q = q.eq("customer_id", customerId);
  const { data } = await q;
  const out: { id: string; customer_id: string; document_number: string; reference: string | null; amount: number; available: number; document_date: string }[] = [];
  for (const r of data ?? []) {
    const { data: a } = await admin.rpc("customer_receipt_available", { p_receipt: r.id });
    if (Number(a ?? 0) > 0.004) out.push({ ...r, amount: Number(r.amount), available: Number(a) });
  }
  return out;
}
