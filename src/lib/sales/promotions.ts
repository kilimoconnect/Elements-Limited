/**
 * Sales promotion rules ("buy N, get M of the same product free"). Pure, so
 * the sales order form previews exactly what the server applies.
 */

export interface PromotionRule {
  id: string;
  name: string;
  product_id: string;
  min_quantity: number;
  free_quantity: number;
  repeat_per_multiple: boolean;
  reward_timing: "current_order" | "next_order";
  starts_on: string;
  ends_on: string | null;
}

/** True when the promotion runs on the given order date (YYYY-MM-DD). */
export function promotionRunsOn(rule: PromotionRule, date: string): boolean {
  return rule.starts_on <= date && (!rule.ends_on || rule.ends_on >= date);
}

/** Free quantity earned for buying `bought` of the promotion's product in one order. */
export function freeQuantityFor(rule: PromotionRule, bought: number): number {
  if (!(bought >= rule.min_quantity)) return 0;
  const times = rule.repeat_per_multiple ? Math.floor(bought / rule.min_quantity + 1e-9) : 1;
  return Math.round(times * rule.free_quantity * 10000) / 10000;
}

export interface EarnedFree { promotion: PromotionRule; quantity: number }

/**
 * What an order earns, per promotion: `bought` maps product id to the paid
 * quantity in the order. Only promotions running on the order date count;
 * Walk-in customers earn nothing.
 */
export function earnedFreeGoods(rules: PromotionRule[], bought: Map<string, number>, date: string, isWalkIn: boolean): EarnedFree[] {
  if (isWalkIn) return [];
  const out: EarnedFree[] = [];
  for (const r of rules) {
    if (!promotionRunsOn(r, date)) continue;
    const q = freeQuantityFor(r, bought.get(r.product_id) ?? 0);
    if (q > 0) out.push({ promotion: r, quantity: q });
  }
  return out;
}

export function describePromotion(r: Pick<PromotionRule, "min_quantity" | "free_quantity" | "repeat_per_multiple" | "reward_timing">): string {
  const n = (x: number) => Number(x).toLocaleString("en-US", { maximumFractionDigits: 4 });
  return `Buy ${n(r.min_quantity)}, get ${n(r.free_quantity)} free${r.repeat_per_multiple ? ` for every ${n(r.min_quantity)}` : ""}, ${r.reward_timing === "current_order" ? "in the same order" : "in the next order"}`;
}
