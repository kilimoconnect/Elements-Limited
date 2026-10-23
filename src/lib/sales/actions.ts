"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission, assertBranchAccess } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import { callPostingRpc, type RpcResult } from "@/lib/rpc";
import { calcLine, calcTotals, round2 } from "@/lib/sales/calc";
import { earnedFreeGoods, type PromotionRule } from "@/lib/sales/promotions";

export interface SaleLineInput {
  product_id: string;
  quantity: number;
  unit_price: number;
  discount: number;
  tax_code_id?: string | null;
}
export interface SalePaymentInput {
  payment_account_id: string;
  amount: number;
  reference?: string;
  payment_date?: string;
}
export interface SaleDraftInput {
  saleId?: string;
  branchId: string;
  documentDate: string;
  dueDate?: string | null;
  customerId: string;
  customerReference?: string;
  salespersonId?: string | null;
  notes?: string;
  lines: SaleLineInput[];
  payments: SalePaymentInput[];
  /** Give the customer the free goods they earned in earlier orders (default yes). */
  redeemRewards?: boolean;
}

/** Free-goods lines (price 0) for the order: same-order promotions plus earlier rewards being redeemed. */
async function promotionLines(
  admin: ReturnType<typeof createAdminClient>, companyId: string, input: SaleDraftInput,
): Promise<Record<string, unknown>[]> {
  const { data: cust } = await admin.from("customers").select("is_protected, company_id").eq("id", input.customerId).maybeSingle();
  if (!cust || cust.company_id !== companyId || cust.is_protected) return [];

  const bought = new Map<string, number>();
  for (const l of input.lines) bought.set(l.product_id, (bought.get(l.product_id) ?? 0) + Number(l.quantity));
  const { data: rules } = await admin.from("sales_promotions")
    .select("id, name, product_id, min_quantity, free_quantity, repeat_per_multiple, reward_timing, starts_on, ends_on")
    .eq("company_id", companyId).eq("is_active", true).eq("reward_timing", "current_order")
    .in("product_id", [...bought.keys()]);
  const earned = earnedFreeGoods((rules ?? []).map(toRule), bought, input.documentDate, false);

  const rewards = input.redeemRewards === false ? [] : ((await admin.from("promotion_rewards")
    .select("id, promotion_id, product_id, quantity, promotion:sales_promotions(name)")
    .eq("company_id", companyId).eq("customer_id", input.customerId).eq("status", "available")).data ?? []) as unknown as
    { id: string; promotion_id: string; product_id: string; quantity: number; promotion: { name: string } | null }[];

  const ids = [...new Set([...earned.map((e) => e.promotion.product_id), ...rewards.map((r) => r.product_id)])];
  if (ids.length === 0) return [];
  const { data: prods } = await admin.from("products").select("id, name, selling_price, track_inventory, is_active").in("id", ids);
  const pm = new Map((prods ?? []).map((p) => [p.id, p]));
  const free = (productId: string, qty: number, label: string, promotionId: string, rewardId: string | null) => {
    const p = pm.get(productId);
    if (!p || !p.is_active) return null;
    return {
      product_id: productId, description: `${p.name} - FREE (${label})`, quantity: qty, unit_price: 0,
      original_price: Number(p.selling_price), discount: 0, tax_code_id: null, tax_rate: 0, tax_type: null, tax_name: null,
      tax_inclusive: false, net_amount: 0, tax_amount: 0, line_total: 0, track_inventory: p.track_inventory,
      is_free: true, promotion_id: promotionId, promotion_reward_id: rewardId,
    };
  };
  return [
    ...earned.map((e) => free(e.promotion.product_id, e.quantity, e.promotion.name, e.promotion.id, null)),
    ...rewards.map((r) => free(r.product_id, Number(r.quantity), `${r.promotion?.name ?? "promotion"}, earned earlier`, r.promotion_id, r.id)),
  ].filter(Boolean) as Record<string, unknown>[];
}

async function releaseRewards(admin: ReturnType<typeof createAdminClient>, ids: string[]) {
  if (ids.length) await admin.from("promotion_rewards").update({ status: "available", redeemed_sale_id: null, redeemed_at: null }).in("id", ids);
}

/** After a sale posts: record the free goods it earns for the customer's next order. */
async function earnNextOrderRewards(admin: ReturnType<typeof createAdminClient>, sale: { id: string; company_id: string; customer_id: string; document_date: string }) {
  const { data: cust } = await admin.from("customers").select("is_protected").eq("id", sale.customer_id).maybeSingle();
  if (!cust || cust.is_protected) return;
  const { data: lines } = await admin.from("sale_lines").select("product_id, quantity").eq("sale_id", sale.id).eq("is_free", false);
  const bought = new Map<string, number>();
  for (const l of lines ?? []) bought.set(l.product_id, (bought.get(l.product_id) ?? 0) + Number(l.quantity));
  if (bought.size === 0) return;
  const { data: rules } = await admin.from("sales_promotions")
    .select("id, name, product_id, min_quantity, free_quantity, repeat_per_multiple, reward_timing, starts_on, ends_on")
    .eq("company_id", sale.company_id).eq("is_active", true).eq("reward_timing", "next_order").in("product_id", [...bought.keys()]);
  const earned = earnedFreeGoods((rules ?? []).map(toRule), bought, sale.document_date, false);
  if (earned.length === 0) return;
  await admin.from("promotion_rewards").upsert(earned.map((e) => ({
    company_id: sale.company_id, promotion_id: e.promotion.id, customer_id: sale.customer_id,
    product_id: e.promotion.product_id, quantity: e.quantity, earned_sale_id: sale.id,
  })), { onConflict: "promotion_id,earned_sale_id", ignoreDuplicates: true });
}

function toRule(r: Record<string, unknown>): PromotionRule {
  return {
    id: String(r.id), name: String(r.name), product_id: String(r.product_id),
    min_quantity: Number(r.min_quantity), free_quantity: Number(r.free_quantity),
    repeat_per_multiple: r.repeat_per_multiple === true, reward_timing: r.reward_timing as PromotionRule["reward_timing"],
    starts_on: String(r.starts_on), ends_on: (r.ends_on as string | null) ?? null,
  };
}

export async function saveSaleDraft(input: SaleDraftInput): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, input.saleId ? "sales.edit_draft" : "sales.create");
    const ctx = await getActiveContext();
    assertBranchAccess(user, input.branchId);
    if (input.lines.length === 0) return { ok: false, error: "Add at least one product line." };

    const admin = createAdminClient();

    // Trusted snapshots from products + tax codes (same company, active).
    const productIds = input.lines.map((l) => l.product_id);
    const { data: products } = await admin
      .from("products")
      .select("id, name, sku, selling_price, tax_code_id, track_inventory, is_active, company_id")
      .in("id", productIds);
    const pMap = new Map((products ?? []).map((p) => [p.id, p]));

    const taxIds = Array.from(new Set(
      input.lines.map((l) => l.tax_code_id).filter(Boolean) as string[],
    ));
    const productTaxIds = (products ?? []).map((p) => p.tax_code_id).filter(Boolean) as string[];
    const { data: taxCodes } = await admin
      .from("tax_codes")
      .select("id, name, tax_type, rate, is_inclusive, company_id, is_active")
      .in("id", Array.from(new Set([...taxIds, ...productTaxIds])).length ? Array.from(new Set([...taxIds, ...productTaxIds])) : ["00000000-0000-0000-0000-000000000000"]);
    const tMap = new Map((taxCodes ?? []).map((t) => [t.id, t]));

    const canOverride = userHasPermission(user, "sales.override_price");
    const lineRows: Record<string, unknown>[] = [];
    let overrode = false;

    input.lines.forEach((l, i) => {
      const p = pMap.get(l.product_id);
      if (!p) throw new Error("A selected product is invalid.");
      if (p.company_id !== ctx.companyId) throw new Error("A product belongs to another company.");
      if (!p.is_active) throw new Error(`Product ${p.sku} is inactive.`);
      if (!(l.quantity > 0)) throw new Error("Quantity must be greater than zero.");
      if (l.unit_price < 0) throw new Error("Price cannot be negative.");
      if (l.discount < 0) throw new Error("Discount cannot be negative.");

      const original = Number(p.selling_price);
      if (round2(l.unit_price) !== round2(original)) {
        if (!canOverride) throw new Error("You are not allowed to change the selling price.");
        overrode = true;
      }

      const taxId = l.tax_code_id ?? p.tax_code_id ?? null;
      const tc = taxId ? tMap.get(taxId) : null;
      if (taxId && tc && tc.company_id !== ctx.companyId) throw new Error("Tax code belongs to another company.");
      const rate = tc ? Number(tc.rate) : 0;
      const inclusive = tc ? tc.is_inclusive : false;

      const r = calcLine({ quantity: l.quantity, unitPrice: l.unit_price, discount: l.discount, taxRate: rate, taxInclusive: inclusive });
      if (r.base < 0) throw new Error("Discount exceeds the line value.");

      lineRows.push({
        product_id: l.product_id,
        description: p.name,
        quantity: l.quantity,
        unit_price: l.unit_price,
        original_price: original,
        discount: l.discount,
        tax_code_id: taxId,
        tax_rate: rate,
        tax_type: tc?.tax_type ?? null,
        tax_name: tc?.name ?? null,
        tax_inclusive: inclusive,
        net_amount: r.net,
        tax_amount: r.tax,
        line_total: r.lineTotal,
        track_inventory: p.track_inventory,
        line_no: i + 1,
      });
    });

    const totals = calcTotals(input.lines.map((l) => {
      const p = pMap.get(l.product_id)!;
      const taxId = l.tax_code_id ?? p.tax_code_id ?? null;
      const tc = taxId ? tMap.get(taxId) : null;
      return { quantity: l.quantity, unitPrice: l.unit_price, discount: l.discount, taxRate: tc ? Number(tc.rate) : 0, taxInclusive: tc ? tc.is_inclusive : false };
    }));

    const paid = round2(input.payments.reduce((s, p) => s + (p.amount || 0), 0));
    if (paid < 0) return { ok: false, error: "Payments cannot be negative." };
    if (paid > totals.grand + 0.001) return { ok: false, error: "Payments exceed the sale total." };
    const outstanding = round2(totals.grand - paid);
    const isCredit = outstanding > 0;

    const header = {
      company_id: ctx.companyId,
      branch_id: input.branchId,
      document_date: input.documentDate,
      due_date: input.dueDate || null,
      customer_id: input.customerId,
      customer_reference: input.customerReference || null,
      salesperson_id: input.salespersonId || null,
      notes: input.notes || null,
      is_credit: isCredit,
      subtotal: totals.subtotal,
      discount_total: totals.discount,
      net_total: totals.net,
      tax_total: totals.tax,
      grand_total: totals.grand,
      amount_paid: paid,
      outstanding,
      payment_status: paid <= 0 ? "unpaid" : paid < totals.grand ? "partially_paid" : "paid",
      updated_by: user.id,
    };

    let saleId = input.saleId ?? null;
    if (saleId) {
      const { data: existing } = await admin.from("sales").select("document_status, approval_status, company_id, branch_id").eq("id", saleId).maybeSingle();
      if (!existing || existing.company_id !== ctx.companyId) return { ok: false, error: "Sale not found." };
      if (existing.document_status !== "draft") return { ok: false, error: "Only drafts can be edited." };
      if (existing.approval_status === "pending") return { ok: false, error: "This order is awaiting approval and cannot be edited." };
      assertBranchAccess(user, existing.branch_id);
      // An edited order (including a rejected one) goes back to "not submitted".
      const { error } = await admin.from("sales").update({ ...header, approval_status: "not_submitted" }).eq("id", saleId);
      if (error) return { ok: false, error: error.message };
      await admin.from("sale_lines").delete().eq("sale_id", saleId);
      await admin.from("sale_payments").delete().eq("sale_id", saleId);
    } else {
      const { data, error } = await admin.from("sales").insert({ ...header, created_by: user.id }).select("id").single();
      if (error) return { ok: false, error: error.message };
      saleId = data.id;
    }

    // Free goods are recomputed by the server on every save; the form only previews them.
    const freeRows = (await promotionLines(admin, ctx.companyId, input)).map((r, i) => ({ ...r, line_no: lineRows.length + i + 1 }));
    await admin.from("sale_lines").insert([...lineRows, ...freeRows].map((r) => ({ ...r, sale_id: saleId })));
    if (input.payments.length) {
      await admin.from("sale_payments").insert(input.payments.filter((p) => p.amount > 0).map((p) => ({
        sale_id: saleId, payment_account_id: p.payment_account_id, amount: p.amount,
        reference: p.reference || null, payment_date: p.payment_date || input.documentDate,
      })));
    }

    await writeAuditLog({
      userId: user.id, companyId: ctx.companyId, branchId: input.branchId,
      action: input.saleId ? "sale.draft_edit" : "sale.draft_create",
      resourceType: "sale", resourceId: saleId!,
    });
    if (overrode) {
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "sale.price_override", resourceType: "sale", resourceId: saleId! });
    }
    revalidatePath("/sales/history");
    return { ok: true, id: saleId! };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

/** Proof of payment is required on an order the customer has paid (fully or partly). */
async function proofProblem(admin: ReturnType<typeof createAdminClient>, saleId: string, amountPaid: number): Promise<string | null> {
  if (!(Number(amountPaid) > 0)) return null;
  const { count } = await admin.from("document_attachments").select("id", { count: "exact", head: true })
    .eq("owner_type", "sale").eq("owner_id", saleId).eq("category", "proof_of_payment");
  return (count ?? 0) > 0 ? null : "Attach proof of payment before this order can be approved.";
}

/** Sales / Cashier sends a sales order to the Branch Manager for approval. */
export async function submitSaleForApproval(saleId: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "sales.create");
    const ctx = await getActiveContext();
    const admin = createAdminClient();
    const { data: sale } = await admin.from("sales").select("*").eq("id", saleId).maybeSingle();
    if (!sale || sale.company_id !== ctx.companyId) return { ok: false, error: "Sale not found." };
    assertBranchAccess(user, sale.branch_id);
    if (sale.document_status !== "draft") return { ok: false, error: "Only draft orders can be submitted." };
    if (sale.approval_status === "pending") return { ok: false, error: "This order is already awaiting approval." };

    if (Number(sale.outstanding) > 0) {
      if (!sale.due_date) return { ok: false, error: "A due date is required when there is an outstanding balance." };
      const { data: cust } = await admin.from("customers").select("is_protected").eq("id", sale.customer_id).maybeSingle();
      if (cust?.is_protected) return { ok: false, error: "A Walk-in Customer order must be paid in full." };
    }
    const proof = await proofProblem(admin, saleId, Number(sale.amount_paid));
    if (proof) return { ok: false, error: proof };

    const { error } = await admin.from("sales").update({
      approval_status: "pending", submitted_by: user.id, submitted_at: new Date().toISOString(),
      rejected_by: null, rejected_at: null, rejection_reason: null, updated_by: user.id,
    }).eq("id", saleId).eq("document_status", "draft");
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: sale.branch_id, action: "sale.submit_for_approval", resourceType: "sale", resourceId: saleId });
    revalidatePath("/sales/history"); revalidatePath("/sales/approvals"); revalidatePath(`/sales/${saleId}`);
    return { ok: true, id: saleId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

/** Sends a sales order back to its creator with a reason; it can be corrected and resubmitted. */
export async function rejectSale(saleId: string, reason: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "sales.approve");
    const ctx = await getActiveContext();
    if (!reason?.trim()) return { ok: false, error: "A reason is required." };
    const admin = createAdminClient();
    const { data: sale } = await admin.from("sales").select("company_id, branch_id, document_status, approval_status").eq("id", saleId).maybeSingle();
    if (!sale || sale.company_id !== ctx.companyId) return { ok: false, error: "Sale not found." };
    assertBranchAccess(user, sale.branch_id);
    if (sale.document_status !== "draft" || sale.approval_status !== "pending") return { ok: false, error: "Only orders awaiting approval can be rejected." };
    const { error } = await admin.from("sales").update({
      approval_status: "rejected", rejected_by: user.id, rejected_at: new Date().toISOString(),
      rejection_reason: reason.trim(), updated_by: user.id,
    }).eq("id", saleId).eq("approval_status", "pending");
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: sale.branch_id, action: "sale.reject", resourceType: "sale", resourceId: saleId, reason });
    revalidatePath("/sales/history"); revalidatePath("/sales/approvals"); revalidatePath(`/sales/${saleId}`);
    return { ok: true, id: saleId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

/**
 * Approves a sales order, which posts the sale (stock, accounts, invoice
 * number). Only approvers (sales.approve) of the order's branch can do this.
 */
export async function approveSale(saleId: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "sales.approve");
    const ctx = await getActiveContext();

    const admin = createAdminClient();
    const { data: sale } = await admin.from("sales").select("*").eq("id", saleId).maybeSingle();
    if (!sale || sale.company_id !== ctx.companyId) return { ok: false, error: "Sale not found." };
    if (sale.document_status !== "draft") return { ok: false, error: "Sale is not a draft." };
    assertBranchAccess(user, sale.branch_id);

    // Walk-in credit block
    if (sale.outstanding > 0) {
      const { data: cust } = await admin.from("customers").select("is_protected").eq("id", sale.customer_id).maybeSingle();
      if (cust?.is_protected && !user.isOwner) {
        return { ok: false, error: "A Walk-in Customer sale cannot be posted on credit." };
      }
    }
    const proof = await proofProblem(admin, saleId, Number(sale.amount_paid));
    if (proof) return { ok: false, error: proof };

    // Below-cost check
    if (!userHasPermission(user, "sales.sell_below_cost")) {
      const { data: lines } = await admin.from("sale_lines").select("product_id, unit_price, track_inventory, is_free").eq("sale_id", saleId);
      const prodIds = (lines ?? []).filter((l) => l.track_inventory).map((l) => l.product_id);
      if (prodIds.length) {
        const { data: bals } = await admin.from("stock_balances").select("product_id, avg_unit_cost")
          .eq("company_id", ctx.companyId).eq("branch_id", sale.branch_id).in("product_id", prodIds);
        const costMap = new Map((bals ?? []).map((b) => [b.product_id, Number(b.avg_unit_cost)]));
        for (const l of lines ?? []) {
          // Promotion free goods are given at price 0 by design.
          if (!l.track_inventory || l.is_free) continue;
          const cost = costMap.get(l.product_id) ?? 0;
          if (cost > 0 && Number(l.unit_price) < cost) {
            return { ok: false, error: "You are not allowed to sell below cost." };
          }
        }
      }
    }

    // Claim the earlier rewards this order gives out, so the same free goods cannot be given twice.
    const { data: rewardLines } = await admin.from("sale_lines").select("promotion_reward_id").eq("sale_id", saleId).not("promotion_reward_id", "is", null);
    const rewardIds = [...new Set((rewardLines ?? []).map((l) => l.promotion_reward_id as string))];
    const claimedAt = new Date().toISOString();
    if (rewardIds.length) {
      const { data: claimed } = await admin.from("promotion_rewards")
        .update({ status: "redeemed", redeemed_sale_id: saleId, redeemed_at: claimedAt })
        .in("id", rewardIds).eq("status", "available").eq("customer_id", sale.customer_id).select("id");
      if ((claimed ?? []).length !== rewardIds.length) {
        await releaseRewards(admin, (claimed ?? []).map((c) => c.id));
        return { ok: false, error: "Free goods earned earlier on this order were already given in another order. Edit and save the order to refresh them." };
      }
    }

    const res = await callPostingRpc("post_sale", { p_id: saleId, p_user: user.id, p_idem: randomUUID() });
    if (!res.ok) await releaseRewards(admin, rewardIds);
    if (res.ok) {
      const now = new Date().toISOString();
      await admin.from("sales").update({
        approval_status: "approved", approved_by: user.id, approved_at: now,
        submitted_by: sale.submitted_by ?? user.id, submitted_at: sale.submitted_at ?? now,
      }).eq("id", saleId);
      await earnNextOrderRewards(admin, sale);
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: sale.branch_id, action: "sale.approve", resourceType: "sale", resourceId: saleId });
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: sale.branch_id, action: "sale.post", resourceType: "sale", resourceId: saleId });
      revalidatePath("/sales/history"); revalidatePath("/sales/approvals"); revalidatePath(`/sales/${saleId}`); revalidatePath("/inventory"); revalidatePath("/dashboard");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function voidSale(saleId: string, reason: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "transactions.void");
    const res = await callPostingRpc("void_sale", { p_id: saleId, p_user: user.id, p_reason: reason });
    if (res.ok) {
      // Free goods this sale earned for a next order are withdrawn (unless already given);
      // free goods it gave out from earlier orders become available again.
      const admin = createAdminClient();
      await admin.from("promotion_rewards").update({ status: "cancelled" }).eq("earned_sale_id", saleId).eq("status", "available");
      await admin.from("promotion_rewards").update({ status: "available", redeemed_sale_id: null, redeemed_at: null }).eq("redeemed_sale_id", saleId).eq("status", "redeemed");
      await writeAuditLog({ userId: user.id, action: "sale.void", resourceType: "sale", resourceId: saleId, reason });
      revalidatePath("/sales/history"); revalidatePath(`/sales/${saleId}`); revalidatePath("/inventory"); revalidatePath("/dashboard");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function deleteSaleDraft(saleId: string, reason: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "transactions.delete_draft");
    const admin = createAdminClient();
    const { data: sale } = await admin.from("sales").select("document_status, document_number").eq("id", saleId).maybeSingle();
    if (!sale) return { ok: false, error: "Sale not found." };
    if (sale.document_status !== "draft") return { ok: false, error: "Only drafts can be deleted." };
    const { error } = await admin.from("sales").delete().eq("id", saleId);
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, action: "sale.draft_delete", resourceType: "sale", resourceId: saleId, reason });
    revalidatePath("/sales/history");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

/* -------------------------------- Returns ------------------------------- */

export async function createAndPostReturn(input: {
  saleId: string;
  returnDate: string;
  reason: string;
  notes?: string;
  lines: { sale_line_id: string; quantity: number; condition: "saleable" | "damaged" }[];
  refunds: { payment_account_id: string; amount: number; reference?: string }[];
}): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "sales.create_return");
    const ctx = await getActiveContext();
    if (!input.reason?.trim()) return { ok: false, error: "A reason is required." };
    if (input.lines.length === 0) return { ok: false, error: "Select at least one line to return." };

    const admin = createAdminClient();
    const { data: sale } = await admin.from("sales").select("*").eq("id", input.saleId).maybeSingle();
    if (!sale || sale.company_id !== ctx.companyId) return { ok: false, error: "Original sale not found." };
    if (sale.document_status !== "posted") return { ok: false, error: "Returns require a posted sale." };
    assertBranchAccess(user, sale.branch_id);

    const { data: saleLines } = await admin.from("sale_lines").select("*").eq("sale_id", input.saleId);
    const slMap = new Map((saleLines ?? []).map((l) => [l.id, l]));

    // Build return lines using original sale-line snapshots.
    let net = 0, tax = 0, total = 0;
    const retLines = input.lines.map((rl, i) => {
      const sl = slMap.get(rl.sale_line_id);
      if (!sl) throw new Error("Invalid return line.");
      if (!(rl.quantity > 0)) throw new Error("Return quantity must be greater than zero.");
      const soldQty = Number(sl.quantity);
      const frac = rl.quantity / soldQty;
      const lnNet = round2(Number(sl.net_amount) * frac);
      const lnTax = round2(Number(sl.tax_amount) * frac);
      const lnTotal = round2(Number(sl.line_total) * frac);
      net = round2(net + lnNet); tax = round2(tax + lnTax); total = round2(total + lnTotal);
      return {
        sale_line_id: sl.id, product_id: sl.product_id, quantity: rl.quantity,
        unit_price: sl.unit_price, tax_rate: sl.tax_rate,
        net_amount: lnNet, tax_amount: lnTax, line_total: lnTotal,
        unit_cost: sl.unit_cost, condition: rl.condition, track_inventory: sl.track_inventory, line_no: i + 1,
      };
    });

    const refundTotal = round2(input.refunds.reduce((s, r) => s + (r.amount || 0), 0));
    if (refundTotal > total + 0.001) return { ok: false, error: "Refund exceeds the return value." };
    const refundMethod = refundTotal <= 0 ? "receivable" : refundTotal >= total ? "payment_account" : "mixed";

    const { data: rHead, error } = await admin.from("sales_returns").insert({
      company_id: ctx.companyId, branch_id: sale.branch_id, sale_id: input.saleId,
      document_date: input.returnDate, customer_id: sale.customer_id, reason: input.reason,
      notes: input.notes || null, refund_method: refundMethod, created_by: user.id, updated_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    const returnId = rHead.id;
    await admin.from("sales_return_lines").insert(retLines.map((l) => ({ ...l, return_id: returnId })));
    if (input.refunds.length) {
      await admin.from("sales_return_refunds").insert(input.refunds.filter((r) => r.amount > 0).map((r) => ({
        return_id: returnId, payment_account_id: r.payment_account_id, amount: r.amount,
        reference: r.reference || null, refund_date: input.returnDate,
      })));
    }

    const res = await callPostingRpc("post_sales_return", { p_id: returnId, p_user: user.id, p_idem: randomUUID() });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: sale.branch_id, action: "sale.return_post", resourceType: "sales_return", resourceId: returnId });
      revalidatePath("/sales/history"); revalidatePath(`/sales/${input.saleId}`); revalidatePath("/inventory"); revalidatePath("/dashboard");
    } else {
      // Clean up the unusable draft return so it does not linger.
      await admin.from("sales_returns").delete().eq("id", returnId);
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function voidReturn(returnId: string, reason: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "transactions.void");
    const res = await callPostingRpc("void_sales_return", { p_id: returnId, p_user: user.id, p_reason: reason });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, action: "sale.return_void", resourceType: "sales_return", resourceId: returnId, reason });
      revalidatePath("/sales/history"); revalidatePath("/inventory"); revalidatePath("/dashboard");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}
