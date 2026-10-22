"use server";

import { revalidatePath } from "next/cache";
import { assertActiveUser } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import { callPostingRpc, type RpcResult } from "@/lib/rpc";
import { suggestPrice, type PricingMode } from "@/lib/pricing/calc";

/**
 * Approve a new selling price from the pricing screen. Never automatic: the
 * user confirms the figure; only the Owner (as for the product master) can
 * save it (re-checked in the database); the change and its costing basis are
 * kept in product_price_changes and the audit log. Inventory cost is untouched.
 */
export async function approveSellingPrice(input: {
  productId: string; price: number; reason: string; requestId: string;
  basis: { branchId: string; accountingCost: number; commercialOverhead: number; mode: PricingMode; ratePct: number; taxRatePct: number; taxInclusive: boolean };
}): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    if (!user.isOwner) return { ok: false, error: "Only the Owner can change approved selling prices." };
    const ctx = await getActiveContext();
    const admin = createAdminClient();
    const { data: p } = await admin.from("products").select("id, company_id, selling_price").eq("id", input.productId).maybeSingle();
    if (!p || p.company_id !== ctx.companyId) return { ok: false, error: "Product not found." };
    if (!input.requestId || input.requestId.length < 16) return { ok: false, error: "Missing request id; reload the page." };
    if (!(input.price >= 0)) return { ok: false, error: "Enter a valid price." };
    const suggestion = suggestPrice(input.basis);
    const basis = { ...input.basis, pricingCost: suggestion.pricingCost, suggestedExVat: suggestion.priceExVat, suggestedSellingPrice: suggestion.sellingPrice };
    const res = await callPostingRpc("set_product_selling_price", {
      p_product: p.id, p_user: user.id, p_price: Math.round(input.price * 100) / 100, p_basis: basis, p_reason: input.reason || null,
      p_idem: `set_product_selling_price:${input.requestId}`,
    });
    if (!res.ok) return res;
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "product.price_change", resourceType: "product", resourceId: p.id,
      oldValues: { selling_price: Number(p.selling_price) }, newValues: { selling_price: input.price, basis }, reason: input.reason || undefined });
    revalidatePath("/inventory/pricing"); revalidatePath("/reports/branch-landed-cost");
    return { ok: true, id: p.id };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}
