"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission, assertBranchAccess } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import { callPostingRpc, type RpcResult } from "@/lib/rpc";

type Line = { product_id: string; quantity: number; unit_cost?: number };

async function guard(permission: string) {
  const user = await assertActiveUser();
  assertPermission(user, permission);
  const ctx = await getActiveContext();
  if (!ctx.branchId) throw new Error("No active branch is assigned to you.");
  assertBranchAccess(user, ctx.branchId);
  return { user, ctx };
}

/* ------------------------------- Openings ------------------------------- */

export async function createOpeningDraft(input: {
  branchId: string;
  openingDate: string;
  reference?: string;
  description?: string;
  lines: Line[];
}): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "inventory.opening_balance");
    const ctx = await getActiveContext();
    assertBranchAccess(user, input.branchId);
    if (input.lines.length === 0) return { ok: false, error: "Add at least one product line." };
    for (const l of input.lines) {
      if (!(l.quantity > 0)) return { ok: false, error: "Opening quantity must be greater than zero." };
      if ((l.unit_cost ?? 0) < 0) return { ok: false, error: "Unit cost cannot be negative." };
    }
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("inventory_openings")
      .insert({
        company_id: ctx.companyId,
        branch_id: input.branchId,
        opening_date: input.openingDate,
        reference: input.reference || null,
        description: input.description || null,
        created_by: user.id,
        updated_by: user.id,
      })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };
    const openingId = data.id;
    await admin.from("inventory_opening_lines").insert(
      input.lines.map((l, i) => ({
        opening_id: openingId,
        product_id: l.product_id,
        quantity: l.quantity,
        unit_cost: l.unit_cost ?? 0,
        total_cost: Math.round((l.quantity * (l.unit_cost ?? 0)) * 100) / 100,
        line_no: i + 1,
      })),
    );
    await writeAuditLog({
      userId: user.id, companyId: ctx.companyId, branchId: input.branchId,
      action: "inventory.opening_draft", resourceType: "inventory_opening", resourceId: openingId,
    });
    revalidatePath("/inventory/opening-balances");
    return { ok: true, id: openingId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function postOpening(id: string): Promise<RpcResult> {
  try {
    const { user, ctx } = await guard("inventory.opening_balance");
    const res = await callPostingRpc("post_inventory_opening", {
      p_id: id, p_user: user.id, p_idem: randomUUID(),
    });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "inventory.opening_post", resourceType: "inventory_opening", resourceId: id });
      revalidatePath("/inventory/opening-balances");
      revalidatePath("/inventory");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function voidOpening(id: string, reason: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "transactions.void");
    const res = await callPostingRpc("void_inventory_opening", { p_id: id, p_user: user.id, p_reason: reason });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, action: "inventory.opening_void", resourceType: "inventory_opening", resourceId: id, reason });
      revalidatePath("/inventory/opening-balances");
      revalidatePath("/inventory");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function deleteOpeningDraft(id: string, reason: string): Promise<RpcResult> {
  return deleteDraftGeneric("inventory_openings", id, reason, "inventory_opening", "/inventory/opening-balances");
}

/* ------------------------------ Adjustments ----------------------------- */

export async function createAdjustmentDraft(input: {
  branchId: string;
  adjustmentDate: string;
  direction: "increase" | "decrease";
  reason: string;
  description?: string;
  reference?: string;
  lines: Line[];
}): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "inventory.adjustment_create");
    const ctx = await getActiveContext();
    assertBranchAccess(user, input.branchId);
    if (!input.reason?.trim()) return { ok: false, error: "A reason is required." };
    if (input.lines.length === 0) return { ok: false, error: "Add at least one product line." };
    for (const l of input.lines) {
      if (!(l.quantity > 0)) return { ok: false, error: "Quantity must be greater than zero." };
      if (input.direction === "increase" && (l.unit_cost ?? 0) < 0)
        return { ok: false, error: "Unit cost cannot be negative." };
    }
    const admin = createAdminClient();
    const { data, error } = await admin.from("stock_adjustments").insert({
      company_id: ctx.companyId, branch_id: input.branchId, adjustment_date: input.adjustmentDate,
      direction: input.direction, reason: input.reason, description: input.description || null,
      reference: input.reference || null, created_by: user.id, updated_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    const adjId = data.id;
    await admin.from("stock_adjustment_lines").insert(
      input.lines.map((l, i) => ({
        adjustment_id: adjId, product_id: l.product_id, quantity: l.quantity,
        unit_cost: input.direction === "increase" ? (l.unit_cost ?? 0) : 0, line_no: i + 1,
      })),
    );
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: input.branchId, action: "inventory.adjustment_draft", resourceType: "stock_adjustment", resourceId: adjId });
    revalidatePath("/inventory/adjustments");
    return { ok: true, id: adjId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function postAdjustment(id: string): Promise<RpcResult> {
  try {
    const { user, ctx } = await guard("inventory.adjustment_post");
    const res = await callPostingRpc("post_stock_adjustment", { p_id: id, p_user: user.id, p_idem: randomUUID() });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "inventory.adjustment_post", resourceType: "stock_adjustment", resourceId: id });
      revalidatePath("/inventory/adjustments"); revalidatePath("/inventory");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function voidAdjustment(id: string, reason: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "transactions.void");
    const res = await callPostingRpc("void_stock_adjustment", { p_id: id, p_user: user.id, p_reason: reason });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, action: "inventory.adjustment_void", resourceType: "stock_adjustment", resourceId: id, reason });
      revalidatePath("/inventory/adjustments"); revalidatePath("/inventory");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function deleteAdjustmentDraft(id: string, reason: string): Promise<RpcResult> {
  return deleteDraftGeneric("stock_adjustments", id, reason, "stock_adjustment", "/inventory/adjustments");
}

/* ------------------------------- Transfers ------------------------------ */

export async function createTransferDraft(input: {
  sourceBranchId: string;
  destinationBranchId: string;
  transferDate: string;
  expectedDate?: string;
  reference?: string;
  notes?: string;
  sourceLocation?: string;
  destinationLocation?: string;
  lines: { product_id: string; qty_requested: number; batch_reference?: string }[];
}): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "inventory.transfer_create");
    const ctx = await getActiveContext();
    if (input.sourceBranchId === input.destinationBranchId)
      return { ok: false, error: "Source and destination branches must differ." };
    assertBranchAccess(user, input.sourceBranchId);
    if (input.lines.length === 0) return { ok: false, error: "Add at least one product line." };
    // Both branches must belong to the same company.
    const admin = createAdminClient();
    const { data: br } = await admin.from("branches").select("id, company_id")
      .in("id", [input.sourceBranchId, input.destinationBranchId]);
    if (!br || br.length !== 2 || br.some((b) => b.company_id !== ctx.companyId))
      return { ok: false, error: "Both branches must belong to your company." };

    const { data, error } = await admin.from("stock_transfers").insert({
      company_id: ctx.companyId, source_branch_id: input.sourceBranchId,
      destination_branch_id: input.destinationBranchId, transfer_date: input.transferDate,
      expected_date: input.expectedDate || null, reference: input.reference || null,
      notes: input.notes || null, source_location: input.sourceLocation || null, destination_location: input.destinationLocation || null,
      created_by: user.id, updated_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    const tId = data.id;
    await admin.from("stock_transfer_lines").insert(
      input.lines.map((l, i) => ({
        transfer_id: tId, product_id: l.product_id, qty_requested: l.qty_requested, batch_reference: l.batch_reference || null, line_no: i + 1,
      })),
    );
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "inventory.transfer_draft", resourceType: "stock_transfer", resourceId: tId });
    revalidatePath("/inventory/transfers");
    return { ok: true, id: tId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function dispatchTransfer(id: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "inventory.transfer_dispatch");
    // Stable key: a double click or retry replays the first dispatch (branch checked in the database).
    const res = await callPostingRpc("dispatch_stock_transfer", { p_id: id, p_user: user.id, p_idem: `dispatch_stock_transfer:${id}` });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, action: "inventory.transfer_dispatch", resourceType: "stock_transfer", resourceId: id });
      revalidatePath("/inventory/transfers"); revalidatePath(`/inventory/transfers/${id}`); revalidatePath("/inventory");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function receiveTransfer(id: string, lines: { line_id: string; qty: number }[], requestId: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "inventory.transfer_receive");
    const res = await callPostingRpc("receive_stock_transfer", {
      // One key per receipt form: a resubmitted form posts once.
      p_id: id, p_user: user.id, p_lines: lines, p_idem: requestId && requestId.length >= 16 ? requestId : randomUUID(),
    });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, action: "inventory.transfer_receive", resourceType: "stock_transfer", resourceId: id });
      revalidatePath("/inventory/transfers"); revalidatePath(`/inventory/transfers/${id}`); revalidatePath("/inventory");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function voidTransfer(id: string, reason: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "transactions.void");
    const res = await callPostingRpc("void_stock_transfer", { p_id: id, p_user: user.id, p_reason: reason });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, action: "inventory.transfer_void", resourceType: "stock_transfer", resourceId: id, reason });
      revalidatePath("/inventory/transfers"); revalidatePath(`/inventory/transfers/${id}`); revalidatePath("/inventory");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

/* --------------------------- shared draft delete ------------------------ */

async function deleteDraftGeneric(
  table: string, id: string, reason: string, auditType: string, path: string,
): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "transactions.delete_draft");
    if (!userHasPermission(user, "transactions.delete_draft"))
      return { ok: false, error: "Only the Owner can delete drafts." };
    const admin = createAdminClient();
    const { data: row } = await admin.from(table).select("*").eq("id", id).maybeSingle();
    if (!row) return { ok: false, error: "Not found." };
    const status = (row as { document_status?: string; status?: string }).document_status
      ?? (row as { status?: string }).status;
    if (status !== "draft") return { ok: false, error: "Only drafts can be deleted." };
    const { error } = await admin.from(table).delete().eq("id", id);
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({
      userId: user.id, action: `${auditType}.delete_draft`, resourceType: auditType, resourceId: id,
      reason, oldValues: { document_number: (row as { document_number?: string }).document_number ?? null },
    });
    revalidatePath(path);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}
