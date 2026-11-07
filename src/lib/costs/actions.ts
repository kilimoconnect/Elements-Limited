"use server";

import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission, assertBranchAccess } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import { callPostingRpc, type RpcResult } from "@/lib/rpc";
import { round2 } from "@/lib/sales/calc";

/*
 * Late costs and corrections (Stage 7): landed costs on purchases, supplier
 * price debit / credit notes, cost-invoice reversal and supplier refunds.
 * All postings run in database functions that re-check the user, permission,
 * period and amounts; these actions add company scoping and stable retry keys.
 */
const fail = (e: unknown): RpcResult => ({ ok: false, error: e instanceof Error ? e.message : "Failed." });
async function ctxFor(permission: string) {
  const user = await assertActiveUser();
  assertPermission(user, permission);
  const ctx = await getActiveContext();
  return { user, ctx, admin: createAdminClient() };
}
async function loadPurchase(admin: ReturnType<typeof createAdminClient>, id: string, companyId: string) {
  const { data } = await admin.from("purchases").select("id, company_id, branch_id, document_status, document_number, posting_mode, currency_code").eq("id", id).maybeSingle();
  if (!data || data.company_id !== companyId) throw new Error("Purchase not found.");
  return data as { id: string; company_id: string; branch_id: string; document_status: string; document_number: string | null; posting_mode: string; currency_code: string };
}
const reqOk = (r: string) => typeof r === "string" && r.length >= 16;

export async function addPurchaseCost(input: { purchaseId: string; categoryId: string; description?: string; amount: number; basis?: string | null }): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("purchases.post");
    const p = await loadPurchase(admin, input.purchaseId, ctx.companyId);
    assertBranchAccess(user, p.branch_id);
    if (!(input.amount >= 0)) return { ok: false, error: "Amount cannot be negative." };
    const { data, error } = await admin.from("cost_sources").insert({
      company_id: ctx.companyId, owner_type: "purchase", purchase_id: p.id, cost_category_id: input.categoryId,
      description: input.description || null, estimated_amount: round2(input.amount), allocation_basis: input.basis || null,
      created_by: user.id, updated_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: p.branch_id, action: "purchase.landed_cost_add", resourceType: "cost_source", resourceId: data.id });
    revalidatePath(`/purchases/${p.id}`);
    return { ok: true, id: data.id };
  } catch (e) { return fail(e); }
}

export async function accruePurchaseCost(sourceId: string, amount: number, date: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("purchases.post");
    const { data: s } = await admin.from("cost_sources").select("company_id, purchase_id").eq("id", sourceId).maybeSingle();
    if (!s || s.company_id !== ctx.companyId || !s.purchase_id) return { ok: false, error: "Cost not found." };
    const res = await callPostingRpc("accrue_purchase_cost", { p_source: sourceId, p_amount: round2(amount), p_date: date, p_user: user.id, p_idem: `accrue_purchase_cost:${sourceId}` });
    if (!res.ok) return res;
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "purchase.landed_cost_accrue", resourceType: "cost_source", resourceId: sourceId, newValues: { amount, date } });
    revalidatePath(`/purchases/${s.purchase_id}`);
    return res;
  } catch (e) { return fail(e); }
}

export async function removePurchaseCostEstimate(sourceId: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("purchases.post");
    const { data: s } = await admin.from("cost_sources").select("company_id, purchase_id, status").eq("id", sourceId).maybeSingle();
    if (!s || s.company_id !== ctx.companyId || !s.purchase_id) return { ok: false, error: "Cost not found." };
    if (s.status !== "estimated") return { ok: false, error: "Only an estimate can be removed; accrued or invoiced costs are corrected with credit notes." };
    const { error } = await admin.from("cost_sources").update({ status: "voided", updated_by: user.id }).eq("id", sourceId).eq("status", "estimated");
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/purchases/${s.purchase_id}`);
    return { ok: true };
  } catch (e) { return fail(e); }
}

/** Supplier debit / credit note on the goods price of a posted TZS purchase. */
export async function postPurchaseAdjustment(input: {
  purchaseId: string; kind: "debit_note" | "credit_note"; date: string; reference?: string; reason: string; requestId: string;
  lines: { purchase_line_id: string; amount: number }[];
}): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("purchases.post");
    const p = await loadPurchase(admin, input.purchaseId, ctx.companyId);
    assertBranchAccess(user, p.branch_id);
    if (!reqOk(input.requestId)) return { ok: false, error: "Missing request id; reload the page." };
    if (!input.reason?.trim()) return { ok: false, error: "Enter the reason." };
    const lines = input.lines.filter((l) => l.amount > 0);
    if (lines.length === 0) return { ok: false, error: "Enter the amount on at least one line." };
    const { data: prior } = await admin.from("purchase_cost_adjustments").select("id, document_status").eq("company_id", ctx.companyId).eq("client_request_id", input.requestId).maybeSingle();
    if (prior?.document_status === "posted") return { ok: true, id: prior.id };
    if (prior) await admin.from("purchase_cost_adjustments").delete().eq("id", prior.id).eq("document_status", "draft");
    const { data: a, error } = await admin.from("purchase_cost_adjustments").insert({
      company_id: ctx.companyId, purchase_id: p.id, kind: input.kind, document_date: input.date, supplier_reference: input.reference || null,
      reason: input.reason.trim(), client_request_id: input.requestId, created_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    const { error: lErr } = await admin.from("purchase_cost_adjustment_lines").insert(lines.map((l) => ({
      company_id: ctx.companyId, adjustment_id: a.id, purchase_line_id: l.purchase_line_id, amount: round2(l.amount),
    })));
    if (lErr) { await admin.from("purchase_cost_adjustments").delete().eq("id", a.id); return { ok: false, error: lErr.message }; }
    const res = await callPostingRpc("post_purchase_cost_adjustment", { p_id: a.id, p_user: user.id, p_idem: `post_purchase_cost_adjustment:${a.id}` });
    if (!res.ok) { await admin.from("purchase_cost_adjustments").delete().eq("id", a.id).eq("document_status", "draft"); return res; }
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: p.branch_id, action: `purchase.${input.kind}`, resourceType: "purchase_cost_adjustment", resourceId: a.id, reason: input.reason });
    revalidatePath(`/purchases/${p.id}`); revalidatePath("/purchases/history"); revalidatePath("/inventory");
    return { ok: true, id: a.id };
  } catch (e) { return fail(e); }
}

export async function voidCostInvoice(id: string, reason: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("cost_invoices.void");
    const { data: ci } = await admin.from("cost_invoices").select("company_id, branch_id").eq("id", id).maybeSingle();
    if (!ci || ci.company_id !== ctx.companyId) return { ok: false, error: "Cost invoice not found." };
    if (!reason?.trim()) return { ok: false, error: "Enter the reason." };
    const res = await callPostingRpc("void_cost_invoice", { p_id: id, p_user: user.id, p_reason: reason.trim(), p_idem: `void_cost_invoice:${id}` });
    if (!res.ok) return res;
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: ci.branch_id, action: "cost_invoice.void", resourceType: "cost_invoice", resourceId: id, reason });
    ["/imports/cost-invoices", "/imports", "/inventory", "/inventory/transfers", "/inventory/rebagging"].forEach((p) => revalidatePath(p));
    return res;
  } catch (e) { return fail(e); }
}

export async function refundSupplierCredit(input: { creditId: string; paymentAccountId: string; amount: number; date: string; reference?: string; requestId: string }): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("purchases.record_payment");
    const { data: c } = await admin.from("supplier_credits").select("company_id").eq("id", input.creditId).maybeSingle();
    if (!c || c.company_id !== ctx.companyId) return { ok: false, error: "Supplier credit not found." };
    if (!reqOk(input.requestId)) return { ok: false, error: "Missing request id; reload the page." };
    const res = await callPostingRpc("refund_supplier_credit", {
      p_credit: input.creditId, p_payment_account: input.paymentAccountId, p_amount: round2(input.amount), p_date: input.date,
      p_reference: input.reference || null, p_user: user.id, p_idem: `refund_supplier_credit:${input.requestId}`,
    });
    if (!res.ok) return res;
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "supplier.credit_refund", resourceType: "supplier_credit", resourceId: input.creditId, newValues: { amount: input.amount } });
    revalidatePath("/purchases/supplier-credits"); revalidatePath("/cash-and-banks");
    return res;
  } catch (e) { return fail(e); }
}

/**
 * A landed cost with its supplier, posted in one step: the supplier's
 * invoice is recorded (Cr Accounts Payable to that supplier) and the cost
 * reaches the purchased goods wherever they are now (stock, cost of sales,
 * other branches, in transit). Nothing is left as an accrual.
 */
export async function postPurchaseLandedCost(input: {
  purchaseId: string; categoryId: string; supplierId: string; supplierInvoiceNumber: string; date: string; dueDate?: string | null;
  amount: number; description?: string; basis?: string | null; requestId: string;
}): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await ctxFor("purchases.post");
    assertPermission(user, "cost_invoices.post");
    const p = await loadPurchase(admin, input.purchaseId, ctx.companyId);
    assertBranchAccess(user, p.branch_id);
    if (!input.supplierId) return { ok: false, error: "Choose the supplier of this cost." };
    if (!input.supplierInvoiceNumber?.trim()) return { ok: false, error: "Enter the supplier's invoice number." };
    if (!(input.amount > 0)) return { ok: false, error: "Enter the amount." };
    if (!input.requestId || input.requestId.length < 16) return { ok: false, error: "Missing request id; reload the page." };
    const { data: sup } = await admin.from("suppliers").select("company_id").eq("id", input.supplierId).maybeSingle();
    if (!sup || sup.company_id !== ctx.companyId) return { ok: false, error: "Supplier not found." };
    const { data: cat } = await admin.from("cost_categories").select("company_id").eq("id", input.categoryId).maybeSingle();
    if (!cat || cat.company_id !== ctx.companyId) return { ok: false, error: "Cost category not found." };

    // A retry with the same request id returns the invoice already posted.
    const { data: prior } = await admin.from("cost_invoices").select("id, document_status").eq("company_id", ctx.companyId).eq("client_request_id", input.requestId).maybeSingle();
    if (prior?.document_status === "posted") return { ok: true, id: prior.id };
    if (prior) await admin.from("cost_invoices").delete().eq("id", prior.id).eq("document_status", "draft");

    const amount = round2(input.amount);
    const { data: src, error: sErr } = await admin.from("cost_sources").insert({
      company_id: ctx.companyId, owner_type: "purchase", purchase_id: p.id, cost_category_id: input.categoryId, supplier_id: input.supplierId,
      description: input.description || null, estimated_amount: amount, allocation_basis: input.basis || null, created_by: user.id, updated_by: user.id,
    }).select("id").single();
    if (sErr) return { ok: false, error: sErr.message };
    const undo = async (ciId?: string) => {
      if (ciId) await admin.from("cost_invoices").delete().eq("id", ciId).eq("document_status", "draft");
      await admin.from("cost_sources").update({ status: "voided", updated_by: user.id }).eq("id", src.id).eq("status", "estimated");
    };
    const { data: ci, error: cErr } = await admin.from("cost_invoices").insert({
      company_id: ctx.companyId, branch_id: p.branch_id, supplier_id: input.supplierId, document_date: input.date,
      supplier_invoice_number: input.supplierInvoiceNumber.trim(), due_date: input.dueDate || null, document_kind: "invoice",
      notes: `Landed cost on purchase ${p.document_number ?? ""}`.trim(), client_request_id: input.requestId, created_by: user.id, updated_by: user.id,
    }).select("id").single();
    if (cErr) { await undo(); return { ok: false, error: cErr.message.includes("unique") ? "This supplier invoice number is already recorded." : cErr.message }; }
    const { error: lErr } = await admin.from("cost_invoice_lines").insert({
      company_id: ctx.companyId, cost_invoice_id: ci.id, cost_category_id: input.categoryId, cost_source_id: src.id,
      description: input.description || null, net_amount: amount, tax_rate: 0, tax_amount: 0, is_recoverable: true, line_no: 1,
    });
    if (lErr) { await undo(ci.id); return { ok: false, error: lErr.message }; }
    const res = await callPostingRpc("post_cost_invoice", { p_id: ci.id, p_user: user.id, p_idem: `post_cost_invoice:${ci.id}` });
    if (!res.ok) { await undo(ci.id); return res; }
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: p.branch_id, action: "purchase.landed_cost_post", resourceType: "cost_invoice", resourceId: ci.id,
      newValues: { purchase_id: p.id, supplier_id: input.supplierId, amount } });
    revalidatePath(`/purchases/${p.id}`); revalidatePath("/cost-invoices");
    return { ok: true, id: ci.id };
  } catch (e) { return fail(e); }
}
