"use server";

import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission, assertBranchAccess } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { callPostingRpc, type RpcResult } from "@/lib/rpc";
import { round2 } from "@/lib/sales/calc";

async function guard(permission: string) {
  const user = await assertActiveUser();
  assertPermission(user, permission);
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "rebagging"))) throw new Error("Rebagging is not enabled.");
  return { user, ctx, admin: createAdminClient() };
}
const fail = (e: unknown): RpcResult => ({ ok: false, error: e instanceof Error ? e.message : "Failed." });
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
function revalidate(id?: string) {
  ["/inventory/rebagging", "/inventory", "/imports", "/dashboard"].forEach((p) => revalidatePath(p));
  if (id) revalidatePath(`/inventory/rebagging/${id}`);
}
async function loadOrder(admin: ReturnType<typeof createAdminClient>, id: string, companyId: string) {
  const { data } = await admin.from("rebag_orders").select("id, company_id, branch_id, document_status, document_number").eq("id", id).maybeSingle();
  if (!data || data.company_id !== companyId) throw new Error("Rebagging order not found.");
  return data as { id: string; company_id: string; branch_id: string; document_status: string; document_number: string | null };
}

export interface RebagOrderInput {
  orderId?: string;
  branchId: string;
  bulkProductId: string;
  shipmentId?: string | null;
  orderDate: string;
  location?: string;
  operatorName?: string;
  notes?: string;
  bulkLines: { lot_id: string | null; kg: number }[];
  outputs: { key: string; product_id: string; bags: number }[];
  packaging: { product_id: string; quantity: number; damaged_qty: number; qty_per_bag: number | null; target_key: string | null }[];
  charges: { category_id: string; description?: string; amount: number; basis: string | null }[];
  returnedKg: number;
  normalLossKg: number;
  abnormalLossKg: number;
}

/**
 * Create or update a draft / issued order with its lines. The bulk issue,
 * branch and product are fixed once issued (also enforced in the database).
 */
export async function saveRebagOrder(input: RebagOrderInput): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await guard("rebagging.create");
    assertBranchAccess(user, input.branchId);
    const existing = input.orderId ? await loadOrder(admin, input.orderId, ctx.companyId) : null;
    if (existing && !["draft", "issued"].includes(existing.document_status)) return { ok: false, error: `A ${existing.document_status} order cannot be edited.` };
    const issued = existing?.document_status === "issued";
    if (input.outputs.some((o) => !Number.isInteger(o.bags) || o.bags <= 0)) return { ok: false, error: "Good bag counts must be whole numbers above zero." };
    if ([input.returnedKg, input.normalLossKg, input.abnormalLossKg].some((v) => !(v >= 0))) return { ok: false, error: "Returned and loss kg cannot be negative." };
    if (!issued && input.bulkLines.filter((l) => l.kg > 0).length === 0) return { ok: false, error: "Enter the bulk kg to issue." };
    if (input.charges.some((c) => !(c.amount > 0))) return { ok: false, error: "Each conversion charge needs an amount; remove the ones not used." };

    const ids = Array.from(new Set([input.bulkProductId, ...input.outputs.map((o) => o.product_id), ...input.packaging.map((p) => p.product_id)]));
    const { data: products } = await admin.from("products").select("id, company_id, stock_role, net_weight_kg, bulk_product_id").in("id", ids);
    const pm = new Map((products ?? []).map((p) => [p.id, p]));
    if (ids.some((id) => pm.get(id)?.company_id !== ctx.companyId)) return { ok: false, error: "Unknown product." };

    const header = {
      branch_id: input.branchId, bulk_product_id: input.bulkProductId, import_shipment_id: input.shipmentId || null,
      order_date: input.orderDate, location: input.location || null, operator_name: input.operatorName || null, notes: input.notes || null,
      returned_kg: round4(input.returnedKg), normal_loss_kg: round4(input.normalLossKg), abnormal_loss_kg: round4(input.abnormalLossKg), updated_by: user.id,
    };
    let id = existing?.id ?? null;
    if (!id) {
      const { data, error } = await admin.from("rebag_orders").insert({ ...header, company_id: ctx.companyId, created_by: user.id }).select("id").single();
      if (error) return { ok: false, error: error.message };
      id = data.id;
    } else {
      const upd = issued
        ? { order_date: header.order_date, location: header.location, operator_name: header.operator_name, notes: header.notes,
            returned_kg: header.returned_kg, normal_loss_kg: header.normal_loss_kg, abnormal_loss_kg: header.abnormal_loss_kg, updated_by: user.id }
        : header;
      const { error } = await admin.from("rebag_orders").update(upd).eq("id", id);
      if (error) return { ok: false, error: error.message };
    }

    // Replace the editable lines (packaging first: it points at outputs).
    await admin.from("rebag_inputs").delete().eq("order_id", id).eq("input_kind", "packaging");
    const { error: dErr } = await admin.from("rebag_outputs").delete().eq("order_id", id);
    if (dErr) return { ok: false, error: dErr.message };
    if (!issued) {
      await admin.from("rebag_inputs").delete().eq("order_id", id).eq("input_kind", "bulk");
      const bulkRows = input.bulkLines.filter((l) => l.kg > 0).map((l, i) => ({
        company_id: ctx.companyId, order_id: id, input_kind: "bulk", product_id: input.bulkProductId, quantity: round4(l.kg), lot_id: l.lot_id || null, line_no: i + 1,
      }));
      const { error } = await admin.from("rebag_inputs").insert(bulkRows);
      if (error) return { ok: false, error: error.message };
    }
    const keyToId = new Map<string, string>();
    for (const [i, o] of input.outputs.entries()) {
      const p = pm.get(o.product_id)!;
      const { data, error } = await admin.from("rebag_outputs").insert({
        company_id: ctx.companyId, order_id: id, product_id: o.product_id, bags: o.bags, net_kg: round4(o.bags * Number(p.net_weight_kg)), line_no: i + 1,
      }).select("id").single();
      if (error) return { ok: false, error: error.message };
      keyToId.set(o.key, data.id);
    }
    const packRows = input.packaging.filter((p) => p.quantity > 0).map((p, i) => ({
      company_id: ctx.companyId, order_id: id, input_kind: "packaging", product_id: p.product_id, quantity: round4(p.quantity),
      damaged_qty: round4(p.damaged_qty || 0), qty_per_bag: p.qty_per_bag && p.qty_per_bag > 0 ? p.qty_per_bag : null,
      target_output_id: p.target_key ? keyToId.get(p.target_key) ?? null : null, line_no: 100 + i,
    }));
    if (packRows.length) {
      const { error } = await admin.from("rebag_inputs").insert(packRows);
      if (error) return { ok: false, error: error.message };
    }
    // Conversion charges stay estimates until completion accrues them.
    await admin.from("cost_sources").delete().eq("rebag_order_id", id).eq("status", "estimated");
    for (const c of input.charges) {
      const { error } = await admin.from("cost_sources").insert({
        company_id: ctx.companyId, owner_type: "rebag_order", rebag_order_id: id, cost_category_id: c.category_id,
        description: c.description || null, estimated_amount: round2(c.amount), allocation_basis: c.basis || null,
        created_by: user.id, updated_by: user.id,
      });
      if (error) return { ok: false, error: error.message };
    }
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: input.branchId, action: existing ? "rebag.order_edit" : "rebag.order_create", resourceType: "rebag_order", resourceId: id! });
    revalidate(id!);
    return { ok: true, id: id! };
  } catch (e) { return fail(e); }
}

async function post(fn: string, id: string, permission: string, action: string, extra: Record<string, unknown> = {}): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await guard(permission);
    const o = await loadOrder(admin, id, ctx.companyId);
    assertBranchAccess(user, o.branch_id);
    // Stable keys: a double click or retry replays the first result.
    const res = await callPostingRpc(fn, { p_id: id, p_user: user.id, ...extra, p_idem: `${fn}:${id}` });
    if (!res.ok) return res;
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: o.branch_id, action, resourceType: "rebag_order", resourceId: id, newValues: extra.p_reason ? { reason: extra.p_reason } : undefined });
    revalidate(id);
    return { ok: true, id };
  } catch (e) { return fail(e); }
}

export async function issueRebagOrder(id: string) { return post("issue_rebag_order", id, "rebagging.post", "rebag.issue"); }
export async function completeRebagOrder(id: string) { return post("complete_rebag_order", id, "rebagging.post", "rebag.complete"); }
export async function cancelRebagOrder(id: string, reason: string) {
  if (!reason?.trim()) return { ok: false, error: "Enter the reason." };
  return post("cancel_rebag_order", id, "rebagging.post", "rebag.cancel", { p_reason: reason.trim() });
}
export async function voidRebagOrder(id: string, reason: string) {
  if (!reason?.trim()) return { ok: false, error: "Enter the reason." };
  return post("void_rebag_order", id, "rebagging.void", "rebag.void", { p_reason: reason.trim() });
}
export async function deleteDraftRebagOrder(id: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await guard("rebagging.create");
    const o = await loadOrder(admin, id, ctx.companyId);
    assertBranchAccess(user, o.branch_id);
    if (o.document_status !== "draft") return { ok: false, error: "Only drafts can be deleted; cancel or void instead." };
    await admin.from("cost_sources").delete().eq("rebag_order_id", id).eq("status", "estimated");
    const { error } = await admin.from("rebag_orders").delete().eq("id", id).eq("document_status", "draft");
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: o.branch_id, action: "rebag.draft_delete", resourceType: "rebag_order", resourceId: id });
    revalidate();
    return { ok: true };
  } catch (e) { return fail(e); }
}
