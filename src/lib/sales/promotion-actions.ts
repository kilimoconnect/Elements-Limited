"use server";

import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import type { RpcResult } from "@/lib/rpc";

export interface PromotionInput {
  id?: string;
  name: string;
  productId: string;
  minQuantity: number;
  freeQuantity: number;
  repeatPerMultiple: boolean;
  rewardTiming: "current_order" | "next_order";
  startsOn: string;
  endsOn: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Creates or updates a sales promotion (admin: promotions.manage). */
export async function savePromotion(input: PromotionInput): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "promotions.manage");
    const ctx = await getActiveContext();
    const name = input.name?.trim();
    if (!name) return { ok: false, error: "Give the promotion a name." };
    if (!(input.minQuantity > 0)) return { ok: false, error: "The minimum quantity must be more than zero." };
    if (!(input.freeQuantity > 0)) return { ok: false, error: "The free quantity must be more than zero." };
    if (!["current_order", "next_order"].includes(input.rewardTiming)) return { ok: false, error: "Choose when the free goods are given." };
    if (!DATE.test(input.startsOn)) return { ok: false, error: "Enter a start date." };
    if (input.endsOn && (!DATE.test(input.endsOn) || input.endsOn < input.startsOn)) return { ok: false, error: "The end date must be on or after the start date." };

    const admin = createAdminClient();
    const { data: product } = await admin.from("products").select("company_id, is_active").eq("id", input.productId).maybeSingle();
    if (!product || product.company_id !== ctx.companyId) return { ok: false, error: "Choose a product." };

    const row = {
      company_id: ctx.companyId, name, product_id: input.productId,
      min_quantity: input.minQuantity, free_quantity: input.freeQuantity,
      repeat_per_multiple: input.repeatPerMultiple, reward_timing: input.rewardTiming,
      starts_on: input.startsOn, ends_on: input.endsOn || null, updated_by: user.id,
    };
    let id = input.id ?? null;
    if (id) {
      const { data: existing } = await admin.from("sales_promotions").select("company_id").eq("id", id).maybeSingle();
      if (!existing || existing.company_id !== ctx.companyId) return { ok: false, error: "Promotion not found." };
      const { error } = await admin.from("sales_promotions").update(row).eq("id", id);
      if (error) return { ok: false, error: error.message };
    } else {
      const { data, error } = await admin.from("sales_promotions").insert({ ...row, created_by: user.id }).select("id").single();
      if (error) return { ok: false, error: error.message };
      id = data.id;
    }
    await writeAuditLog({
      userId: user.id, companyId: ctx.companyId, action: input.id ? "promotion.update" : "promotion.create",
      resourceType: "sales_promotion", resourceId: id!, newValues: row,
    });
    revalidatePath("/sales/promotions");
    return { ok: true, id: id! };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

/** Switches a promotion on or off. Free goods already earned stay available. */
export async function setPromotionActive(id: string, active: boolean): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "promotions.manage");
    const ctx = await getActiveContext();
    const admin = createAdminClient();
    const { data: existing } = await admin.from("sales_promotions").select("company_id").eq("id", id).maybeSingle();
    if (!existing || existing.company_id !== ctx.companyId) return { ok: false, error: "Promotion not found." };
    const { error } = await admin.from("sales_promotions").update({ is_active: active, updated_by: user.id }).eq("id", id);
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: active ? "promotion.activate" : "promotion.deactivate", resourceType: "sales_promotion", resourceId: id });
    revalidatePath("/sales/promotions");
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}
