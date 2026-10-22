"use server";

import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { callPostingRpc, type RpcResult } from "@/lib/rpc";
import { round2 } from "@/lib/sales/calc";
import { todayISO } from "@/lib/format";
import { createTransferDraft } from "@/lib/inventory/actions";

/*
 * Transfer trips, receipts, discrepancies, charges and the shared dispatch file.
 * Every posting runs in a database function that re-checks the user, the
 * permission and the sending / receiving branch; these actions add company
 * scoping, input checks and stable retry keys.
 */

type Admin = ReturnType<typeof createAdminClient>;
const fail = (e: unknown): RpcResult => ({ ok: false, error: e instanceof Error ? e.message : "Failed." });

async function ctxFor(permission: string) {
  const user = await assertActiveUser();
  assertPermission(user, permission);
  const ctx = await getActiveContext();
  return { user, ctx, admin: createAdminClient() };
}
type U = Awaited<ReturnType<typeof assertActiveUser>>;
async function loadTransfer(admin: Admin, id: string, companyId: string, user: U) {
  const { data } = await admin.from("stock_transfers").select("id, company_id, source_branch_id, destination_branch_id, status, posts_in_transit, document_number").eq("id", id).maybeSingle();
  if (!data || data.company_id !== companyId) throw new Error("Transfer not found.");
  if (!user.isOwner && !user.branchIds.includes(data.source_branch_id) && !user.branchIds.includes(data.destination_branch_id)) {
    throw new Error("Only the sending and receiving branches can work on this transfer.");
  }
  return data as { id: string; company_id: string; source_branch_id: string; destination_branch_id: string; status: string; posts_in_transit: boolean; document_number: string | null };
}
async function loadTrip(admin: Admin, tripId: string, companyId: string, user: U) {
  const { data } = await admin.from("stock_transfer_dispatches").select("id, transfer_id, status, document_number, trip_no").eq("id", tripId).maybeSingle();
  if (!data) throw new Error("Trip not found.");
  const t = await loadTransfer(admin, data.transfer_id, companyId, user);
  return { trip: data as { id: string; transfer_id: string; status: string; document_number: string | null; trip_no: number }, t };
}
function refresh(transferId: string) {
  ["/inventory/transfers", "/inventory", "/dashboard"].forEach((p) => revalidatePath(p));
  revalidatePath(`/inventory/transfers/${transferId}`);
}
const reqOk = (r: string) => typeof r === "string" && r.length >= 16;

export interface TripInput {
  transferId: string; dispatchDate: string; expectedArrivalAt?: string | null;
  driverName?: string; driverPhone?: string; driverLicence?: string; vehicleRegistration?: string; trailerRegistration?: string;
  transporterName?: string; transporterContact?: string; notes?: string; requestId: string;
  lines: { transfer_line_id: string; qty: number }[];
}

/** Create a draft trip (cargo + driver / vehicle). Dispatching it posts stock. */
export async function createTrip(input: TripInput): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_dispatch");
    const t = await loadTransfer(admin, input.transferId, ctx.companyId, user);
    if (!user.isOwner && !user.branchIds.includes(t.source_branch_id)) return { ok: false, error: "Only the sending branch prepares trips." };
    if (!t.posts_in_transit) return { ok: false, error: "This transfer was dispatched before the upgrade and cannot take new trips." };
    if (t.status === "voided") return { ok: false, error: "Transfer is voided." };
    if (!reqOk(input.requestId)) return { ok: false, error: "Missing request id; reload the page." };
    const { data: prior } = await admin.from("stock_transfer_dispatches").select("id").eq("company_id", ctx.companyId).eq("client_request_id", input.requestId).maybeSingle();
    if (prior) return { ok: true, id: prior.id };
    const lines = input.lines.filter((l) => l.qty > 0);
    if (lines.length === 0) return { ok: false, error: "Enter the quantity loaded on this trip." };
    const { data: tl } = await admin.from("stock_transfer_lines").select("id, transfer_id, qty_requested, qty_dispatched").in("id", lines.map((l) => l.transfer_line_id));
    const tm = new Map((tl ?? []).map((x) => [x.id, x]));
    for (const l of lines) {
      const x = tm.get(l.transfer_line_id);
      if (!x || x.transfer_id !== t.id) return { ok: false, error: "A cargo line is not part of this transfer." };
    }
    const { data: last } = await admin.from("stock_transfer_dispatches").select("trip_no").eq("transfer_id", t.id).order("trip_no", { ascending: false }).limit(1);
    const { data: trip, error } = await admin.from("stock_transfer_dispatches").insert({
      company_id: ctx.companyId, transfer_id: t.id, trip_no: (last?.[0]?.trip_no ?? 0) + 1, dispatch_date: input.dispatchDate,
      expected_arrival_at: input.expectedArrivalAt || null, driver_name: input.driverName || null, driver_phone: input.driverPhone || null,
      driver_licence: input.driverLicence || null, vehicle_registration: input.vehicleRegistration || null, trailer_registration: input.trailerRegistration || null,
      transporter_name: input.transporterName || null, transporter_contact: input.transporterContact || null, notes: input.notes || null,
      client_request_id: input.requestId, created_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    const { error: lErr } = await admin.from("stock_transfer_dispatch_lines").insert(lines.map((l) => ({
      company_id: ctx.companyId, dispatch_id: trip.id, transfer_line_id: l.transfer_line_id, qty: l.qty,
    })));
    if (lErr) { await admin.from("stock_transfer_dispatches").delete().eq("id", trip.id); return { ok: false, error: lErr.message }; }
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: t.source_branch_id, action: "transfer.trip_create", resourceType: "stock_transfer_dispatch", resourceId: trip.id });
    refresh(t.id);
    return { ok: true, id: trip.id };
  } catch (e) { return fail(e); }
}

export async function deleteDraftTrip(tripId: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_dispatch");
    const { trip, t } = await loadTrip(admin, tripId, ctx.companyId, user);
    if (trip.status !== "draft") return { ok: false, error: "Only a draft trip can be deleted." };
    const { error } = await admin.from("stock_transfer_dispatches").delete().eq("id", tripId).eq("status", "draft");
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "transfer.trip_delete", resourceType: "stock_transfer_dispatch", resourceId: tripId });
    refresh(t.id);
    return { ok: true };
  } catch (e) { return fail(e); }
}

/**
 * Book (accrue) the charge estimates entered on a trip, so they reach the cost
 * of the goods. Needs `inventory.transfer_cost` and the transfer_logistics
 * flag; otherwise they stay as estimates for an approver. Returns how many
 * were left unbooked.
 */
async function accrueTripEstimates(admin: Admin, user: U, companyId: string, tripId: string, date: string): Promise<number> {
  const { data } = await admin.from("cost_sources").select("id, estimated_amount")
    .eq("company_id", companyId).eq("transfer_dispatch_id", tripId).eq("status", "estimated").gt("estimated_amount", 0);
  const open = data ?? [];
  if (open.length === 0) return 0;
  if (!(user.isOwner || user.permissions.has("inventory.transfer_cost")) || !(await isFeatureEnabled(companyId, "transfer_logistics"))) return open.length;
  let left = 0;
  for (const s of open) {
    const res = await callPostingRpc("accrue_transfer_cost", {
      p_source: s.id, p_amount: round2(Number(s.estimated_amount)), p_date: date, p_user: user.id, p_idem: `accrue_transfer_cost:${s.id}`,
    });
    if (res.ok) await writeAuditLog({ userId: user.id, companyId, action: "transfer.charge_accrue", resourceType: "cost_source", resourceId: s.id, newValues: { amount: s.estimated_amount, date } });
    else left++;
  }
  return left;
}
const unbookedNote = (n: number) => n > 0 ? ` ${n} charge(s) left as estimates for an approver with transfer-cost rights.` : "";

/** Dispatch a trip: stock moves to in-transit and the trip's charges are booked. */
export async function dispatchTrip(tripId: string): Promise<RpcResult & { message?: string }> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_dispatch");
    const { t } = await loadTrip(admin, tripId, ctx.companyId, user);
    const res = await callPostingRpc("dispatch_transfer_trip", { p_dispatch: tripId, p_user: user.id, p_idem: `dispatch_transfer_trip:${tripId}` });
    if (!res.ok) return res;
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: t.source_branch_id, action: "transfer.trip_dispatch", resourceType: "stock_transfer_dispatch", resourceId: tripId });
    const { data: trip } = await admin.from("stock_transfer_dispatches").select("dispatch_date").eq("id", tripId).single();
    const left = await accrueTripEstimates(admin, user, ctx.companyId, tripId, trip?.dispatch_date ?? todayISO());
    refresh(t.id);
    return { ok: true, id: tripId, message: `Trip dispatched.${unbookedNote(left)}` };
  } catch (e) { return fail(e); }
}

export interface ChargeInput { categoryId: string; description?: string; amount: number }

async function checkCharges(admin: Admin, companyId: string, charges: ChargeInput[]): Promise<string | null> {
  if (charges.length === 0) return null;
  if (!(await isFeatureEnabled(companyId, "transfer_logistics"))) return "Transfer costs need Transfer logistics switched on (Admin → Feature Flags).";
  if (charges.some((c) => !c.categoryId || !(c.amount > 0))) return "Each charge needs a type and an amount above zero.";
  const { data } = await admin.from("cost_categories").select("id").eq("company_id", companyId).eq("applies_to_transfer", true).eq("is_active", true)
    .in("id", [...new Set(charges.map((c) => c.categoryId))]);
  if ((data ?? []).length !== new Set(charges.map((c) => c.categoryId)).size) return "A charge type is not available for transfers.";
  return null;
}

export interface NewTransferInput {
  sourceBranchId: string; destinationBranchId: string; transferDate: string; expectedArrivalAt?: string | null;
  reference?: string; notes?: string; requestId: string; dispatch: boolean;
  lines: { product_id: string; qty: number }[];
  transport: {
    driverName?: string; driverPhone?: string; driverLicence?: string; vehicleRegistration?: string; trailerRegistration?: string;
    transporterName?: string; transporterContact?: string;
  };
  charges: ChargeInput[];
}

/**
 * The New Transfer screen: the transfer, its truck (driver, licence, phone,
 * vehicle, transporter) and loading / transport / other charges in one step,
 * optionally dispatched at once. A retried request returns the first transfer.
 */
export async function createTransferWithTrip(input: NewTransferInput): Promise<RpcResult & { message?: string }> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_create");
    if (!reqOk(input.requestId)) return { ok: false, error: "Missing request id; reload the page." };
    const { data: prior } = await admin.from("stock_transfer_dispatches").select("transfer_id").eq("company_id", ctx.companyId).eq("client_request_id", input.requestId).maybeSingle();
    if (prior) return { ok: true, id: prior.transfer_id };
    if (input.dispatch && !(user.isOwner || user.permissions.has("inventory.transfer_dispatch"))) return { ok: false, error: "You are not allowed to dispatch transfers." };
    const lines = input.lines.filter((l) => l.product_id && l.qty > 0);
    if (lines.length === 0) return { ok: false, error: "Add at least one product line." };
    if (!input.transport.vehicleRegistration?.trim() || !input.transport.driverName?.trim()) return { ok: false, error: "Enter the truck registration and the driver's name." };
    const chargeErr = await checkCharges(admin, ctx.companyId, input.charges);
    if (chargeErr) return { ok: false, error: chargeErr };

    const created = await createTransferDraft({
      sourceBranchId: input.sourceBranchId, destinationBranchId: input.destinationBranchId, transferDate: input.transferDate,
      expectedDate: input.expectedArrivalAt ? input.expectedArrivalAt.slice(0, 10) : undefined, reference: input.reference, notes: input.notes,
      lines: lines.map((l) => ({ product_id: l.product_id, qty_requested: l.qty })),
    });
    if (!created.ok || !created.id) return created;
    const transferId = created.id;
    const tp = input.transport;
    await admin.from("stock_transfers").update({
      driver_name: tp.driverName || null, driver_phone: tp.driverPhone || null, vehicle_registration: tp.vehicleRegistration || null,
      trailer_registration: tp.trailerRegistration || null, updated_by: user.id,
    }).eq("id", transferId);

    const { data: tl } = await admin.from("stock_transfer_lines").select("id, qty_requested").eq("transfer_id", transferId).order("line_no");
    const trip = await createTrip({
      transferId, dispatchDate: input.transferDate, expectedArrivalAt: input.expectedArrivalAt || null,
      driverName: tp.driverName, driverPhone: tp.driverPhone,
      driverLicence: user.isOwner || user.permissions.has("documents.view_licence") ? tp.driverLicence : undefined,
      vehicleRegistration: tp.vehicleRegistration, trailerRegistration: tp.trailerRegistration,
      transporterName: tp.transporterName, transporterContact: tp.transporterContact, notes: input.notes, requestId: input.requestId,
      lines: (tl ?? []).map((l) => ({ transfer_line_id: l.id, qty: Number(l.qty_requested) })),
    });
    if (!trip.ok || !trip.id) return { ok: false, id: transferId, error: `Transfer saved as a draft, but its trip could not be prepared: ${trip.error ?? "failed"}` };

    for (const c of input.charges) {
      const r = await addTransferCharge({ transferId, tripId: trip.id, categoryId: c.categoryId, description: c.description, amount: c.amount });
      if (!r.ok) return { ok: false, id: transferId, error: `Transfer saved as a draft, but a charge could not be added: ${r.error ?? "failed"}` };
    }

    if (!input.dispatch) { refresh(transferId); return { ok: true, id: transferId, message: "Transfer saved as a draft with its truck and charges." }; }
    const d = await dispatchTrip(trip.id);
    if (!d.ok) return { ok: false, id: transferId, error: `Transfer saved, but dispatch failed: ${d.error ?? "failed"}` };
    return { ok: true, id: transferId, message: d.message };
  } catch (e) { return fail(e); }
}

/**
 * Offloading and other arrival charges, entered by the receiving branch on
 * the trip and booked on the arrival date (they follow the goods received).
 */
export async function addArrivalCharges(input: { transferId: string; tripId: string; date: string; charges: ChargeInput[] }): Promise<RpcResult & { message?: string }> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_receive");
    const { trip, t } = await loadTrip(admin, input.tripId, ctx.companyId, user);
    if (trip.transfer_id !== input.transferId) return { ok: false, error: "Trip not found." };
    if (!user.isOwner && !user.branchIds.includes(t.destination_branch_id)) return { ok: false, error: "Only the receiving branch records arrival charges." };
    const charges = input.charges.filter((c) => c.amount > 0 || c.categoryId);
    if (charges.length === 0) return { ok: true };
    const chargeErr = await checkCharges(admin, ctx.companyId, charges);
    if (chargeErr) return { ok: false, error: chargeErr };
    const ids: string[] = [];
    for (const c of charges) {
      const r = await addTransferCharge({ transferId: t.id, tripId: trip.id, categoryId: c.categoryId, description: c.description, amount: c.amount });
      if (!r.ok || !r.id) return { ok: false, error: r.error ?? "A charge could not be added." };
      ids.push(r.id);
    }
    const left = await accrueTripEstimates(admin, user, ctx.companyId, trip.id, input.date);
    refresh(t.id);
    return { ok: true, message: `${ids.length} arrival charge(s) recorded.${unbookedNote(left)}` };
  } catch (e) { return fail(e); }
}

export async function receiveTrip(input: {
  tripId: string; arrivedAt: string | null; notes?: string; signedBy?: string; requestId: string;
  lines: { dispatch_line_id: string; accepted: number; quarantined: number; short: number }[];
}): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_receive");
    const { t } = await loadTrip(admin, input.tripId, ctx.companyId, user);
    if (!reqOk(input.requestId)) return { ok: false, error: "Missing request id; reload the page." };
    const lines = input.lines.filter((l) => l.accepted + l.quarantined + l.short > 0);
    if (lines.length === 0) return { ok: false, error: "Enter what arrived." };
    if (lines.some((l) => [l.accepted, l.quarantined, l.short].some((v) => !(v >= 0)))) return { ok: false, error: "Quantities cannot be negative." };
    const res = await callPostingRpc("receive_transfer_trip", {
      p_dispatch: input.tripId, p_user: user.id, p_lines: lines, p_arrived_at: input.arrivedAt || null, p_notes: input.notes || null,
      p_signed_by: input.signedBy || null, p_request: input.requestId, p_idem: `receive_transfer_trip:${input.requestId}`,
    });
    if (!res.ok) return res;
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: t.destination_branch_id, action: "transfer.trip_receive", resourceType: "stock_transfer_receipt", resourceId: res.id ?? input.tripId });
    refresh(t.id);
    return res;
  } catch (e) { return fail(e); }
}

export async function resolveDiscrepancy(input: {
  receiptLineId: string; kind: "quarantine" | "short"; resolution: "release" | "found" | "normal_loss" | "write_off" | "claim";
  qty: number; notes?: string; requestId: string;
}): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor(input.resolution === "found" ? "inventory.transfer_receive" : "inventory.transfer_resolve");
    const { data: rl } = await admin.from("stock_transfer_receipt_lines").select("id, company_id, receipt:stock_transfer_receipts(transfer_id)").eq("id", input.receiptLineId).maybeSingle();
    const transferId = (rl as unknown as { receipt: { transfer_id: string } | null } | null)?.receipt?.transfer_id;
    if (!rl || rl.company_id !== ctx.companyId || !transferId) return { ok: false, error: "Receipt line not found." };
    const t = await loadTransfer(admin, transferId, ctx.companyId, user);
    if (!reqOk(input.requestId)) return { ok: false, error: "Missing request id; reload the page." };
    const res = await callPostingRpc("resolve_transfer_discrepancy", {
      p_receipt_line: input.receiptLineId, p_kind: input.kind, p_resolution: input.resolution, p_qty: input.qty, p_notes: input.notes || null,
      p_user: user.id, p_idem: `resolve_transfer_discrepancy:${input.requestId}`,
    });
    if (!res.ok) return res;
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: t.destination_branch_id, action: "transfer.discrepancy_resolve",
      resourceType: "stock_transfer_receipt_line", resourceId: input.receiptLineId, newValues: { kind: input.kind, resolution: input.resolution, qty: input.qty } });
    refresh(t.id);
    return res;
  } catch (e) { return fail(e); }
}

export async function voidTrip(tripId: string, reason: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("transactions.void");
    const { t } = await loadTrip(admin, tripId, ctx.companyId, user);
    if (!reason?.trim()) return { ok: false, error: "Enter the reason." };
    const res = await callPostingRpc("void_transfer_trip", { p_dispatch: tripId, p_user: user.id, p_reason: reason.trim(), p_idem: `void_transfer_trip:${tripId}` });
    if (!res.ok) return res;
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "transfer.trip_void", resourceType: "stock_transfer_dispatch", resourceId: tripId, reason });
    refresh(t.id);
    return res;
  } catch (e) { return fail(e); }
}

export async function changeTripTransport(tripId: string, changes: Record<string, string>, reason: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_dispatch");
    const { t } = await loadTrip(admin, tripId, ctx.companyId, user);
    const clean = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing changed." };
    if ("driver_licence" in clean && !(user.isOwner || user.permissions.has("documents.view_licence"))) {
      return { ok: false, error: "Only users allowed to see licences can change the licence number." };
    }
    const res = await callPostingRpc("change_transfer_trip_transport", { p_dispatch: tripId, p_user: user.id, p_changes: clean, p_reason: reason });
    if (!res.ok) return res;
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "transfer.trip_transport_change", resourceType: "stock_transfer_dispatch", resourceId: tripId, reason });
    refresh(t.id);
    return res;
  } catch (e) { return fail(e); }
}

export async function addTransferUpdate(transferId: string, tripId: string | null, note: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_view");
    await loadTransfer(admin, transferId, ctx.companyId, user);
    const res = await callPostingRpc("add_transfer_update", { p_transfer: transferId, p_dispatch: tripId, p_user: user.id, p_note: note });
    if (!res.ok) return res;
    refresh(transferId);
    return { ok: true };
  } catch (e) { return fail(e); }
}

export async function addAgent(transferId: string, agent: { name: string; company?: string; phone?: string; role?: string }): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_view");
    const t = await loadTransfer(admin, transferId, ctx.companyId, user);
    if (!(user.isOwner || user.permissions.has("inventory.transfer_dispatch") || user.permissions.has("inventory.transfer_receive"))) {
      return { ok: false, error: "Only the people moving the cargo can add agents." };
    }
    if (!agent.name?.trim()) return { ok: false, error: "Enter the agent's name." };
    const { data, error } = await admin.from("stock_transfer_agents").insert({
      company_id: ctx.companyId, transfer_id: t.id, name: agent.name.trim(), company_name: agent.company || null, phone: agent.phone || null,
      role: agent.role || null, created_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    await admin.rpc("add_transfer_update", { p_transfer: t.id, p_dispatch: null, p_user: user.id, p_note: `Agent added: ${agent.name.trim()}${agent.role ? ` (${agent.role})` : ""}` });
    refresh(t.id);
    return { ok: true, id: data.id };
  } catch (e) { return fail(e); }
}

/** Charge estimate on the transfer or one trip (sender or receiver). Estimates post nothing. */
export async function addTransferCharge(input: {
  transferId: string; tripId?: string | null; categoryId: string; description?: string; amount: number; basis?: string | null; supplierId?: string | null;
}): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_view");
    const t = await loadTransfer(admin, input.transferId, ctx.companyId, user);
    if (!(await isFeatureEnabled(ctx.companyId, "transfer_logistics"))) return { ok: false, error: "Transfer logistics is not enabled." };
    if (!(user.isOwner || user.permissions.has("inventory.transfer_cost") || user.permissions.has("inventory.transfer_dispatch") || user.permissions.has("inventory.transfer_receive"))) {
      return { ok: false, error: "Not allowed to record transfer charges." };
    }
    if (!(input.amount >= 0)) return { ok: false, error: "Amount cannot be negative." };
    const { data, error } = await admin.from("cost_sources").insert({
      company_id: ctx.companyId, owner_type: "stock_transfer", stock_transfer_id: t.id, transfer_dispatch_id: input.tripId || null,
      cost_category_id: input.categoryId, description: input.description || null, estimated_amount: round2(input.amount),
      allocation_basis: input.basis || null, supplier_id: input.supplierId || null, created_by: user.id, updated_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "transfer.charge_add", resourceType: "cost_source", resourceId: data.id });
    refresh(t.id);
    return { ok: true, id: data.id };
  } catch (e) { return fail(e); }
}

export async function accrueTransferCharge(sourceId: string, amount: number, date: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_cost");
    const { data: s } = await admin.from("cost_sources").select("company_id, stock_transfer_id").eq("id", sourceId).maybeSingle();
    if (!s || s.company_id !== ctx.companyId || !s.stock_transfer_id) return { ok: false, error: "Charge not found." };
    const res = await callPostingRpc("accrue_transfer_cost", { p_source: sourceId, p_amount: round2(amount), p_date: date, p_user: user.id, p_idem: `accrue_transfer_cost:${sourceId}` });
    if (!res.ok) return res;
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "transfer.charge_accrue", resourceType: "cost_source", resourceId: sourceId, newValues: { amount, date } });
    refresh(s.stock_transfer_id);
    return res;
  } catch (e) { return fail(e); }
}

export async function voidTransferChargeEstimate(sourceId: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_view");
    const { data: s } = await admin.from("cost_sources").select("company_id, stock_transfer_id, status").eq("id", sourceId).maybeSingle();
    if (!s || s.company_id !== ctx.companyId || !s.stock_transfer_id) return { ok: false, error: "Charge not found." };
    await loadTransfer(admin, s.stock_transfer_id, ctx.companyId, user);
    if (s.status !== "estimated") return { ok: false, error: "Only an estimate can be removed; accrued or invoiced charges are corrected with credit notes." };
    const { error } = await admin.from("cost_sources").update({ status: "voided", updated_by: user.id }).eq("id", sourceId).eq("status", "estimated");
    if (error) return { ok: false, error: error.message };
    refresh(s.stock_transfer_id);
    return { ok: true };
  } catch (e) { return fail(e); }
}

/** Issue (or reuse) the delivery-note version for a trip. Posts nothing. */
export async function issueDeliveryNote(tripId: string): Promise<RpcResult & { version?: number }> {
  try {
    const { user, ctx, admin } = await ctxFor("inventory.transfer_view");
    const { t } = await loadTrip(admin, tripId, ctx.companyId, user);
    const { data, error } = await admin.rpc("issue_delivery_note", { p_dispatch: tripId, p_user: user.id });
    if (error) return { ok: false, error: error.message.replace(/^ERROR:\s*/i, "") };
    const row = (data as { version_id: string; version_no: number; is_new: boolean }[])[0];
    if (row?.is_new) {
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "transfer.delivery_note_issue", resourceType: "document_version", resourceId: row.version_id });
      refresh(t.id);
    }
    return { ok: true, id: row.version_id, version: row.version_no };
  } catch (e) { return fail(e); }
}
