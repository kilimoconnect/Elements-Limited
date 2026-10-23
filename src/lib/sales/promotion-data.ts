import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { PromotionRule } from "./promotions";

export interface CustomerReward { product_id: string; quantity: number; label: string }

/** Active promotions and the free goods each customer has waiting, for the sales order form preview. */
export async function loadPromotionPreview(companyId: string): Promise<{ rules: PromotionRule[]; rewards: Record<string, CustomerReward[]> }> {
  const admin = createAdminClient();
  const [{ data: rules }, { data: rewards }] = await Promise.all([
    admin.from("sales_promotions")
      .select("id, name, product_id, min_quantity, free_quantity, repeat_per_multiple, reward_timing, starts_on, ends_on")
      .eq("company_id", companyId).eq("is_active", true),
    admin.from("promotion_rewards")
      .select("customer_id, product_id, quantity, promotion:sales_promotions(name)")
      .eq("company_id", companyId).eq("status", "available"),
  ]);
  const byCustomer: Record<string, CustomerReward[]> = {};
  for (const r of (rewards ?? []) as unknown as { customer_id: string; product_id: string; quantity: number; promotion: { name: string } | null }[]) {
    (byCustomer[r.customer_id] ??= []).push({ product_id: r.product_id, quantity: Number(r.quantity), label: r.promotion?.name ?? "promotion" });
  }
  return {
    rules: (rules ?? []).map((r) => ({
      id: r.id, name: r.name, product_id: r.product_id, min_quantity: Number(r.min_quantity), free_quantity: Number(r.free_quantity),
      repeat_per_multiple: r.repeat_per_multiple, reward_timing: r.reward_timing, starts_on: r.starts_on, ends_on: r.ends_on,
    })),
    rewards: byCustomer,
  };
}
