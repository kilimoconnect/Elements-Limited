/**
 * Sales promotion rules (src/lib/sales/promotions.ts): free quantity per
 * order, repeating multiples, dates and Walk-in exclusion. Pure; no database.
 */
import { earnedFreeGoods, freeQuantityFor, promotionRunsOn, type PromotionRule } from "../src/lib/sales/promotions";

let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { console.error(`  FAIL ${name} ${detail}`); process.exitCode = 1; }
}

const rule = (over: Partial<PromotionRule> = {}): PromotionRule => ({
  id: "p1", name: "Buy 100 get 2", product_id: "A", min_quantity: 100, free_quantity: 2,
  repeat_per_multiple: true, reward_timing: "current_order", starts_on: "2026-01-01", ends_on: null, ...over,
});

check("below the minimum earns nothing", freeQuantityFor(rule(), 99.99) === 0);
check("exactly the minimum earns the free quantity", freeQuantityFor(rule(), 100) === 2);
check("repeating: 250 bought earns 2 × 2 = 4", freeQuantityFor(rule(), 250) === 4);
check("repeating: 300 bought earns 6", freeQuantityFor(rule(), 300) === 6);
check("not repeating: 300 bought earns 2 once", freeQuantityFor(rule({ repeat_per_multiple: false }), 300) === 2);
check("fractional minimums repeat correctly (0.5 → 3 times in 1.5)", freeQuantityFor(rule({ min_quantity: 0.5, free_quantity: 1 }), 1.5) === 3);

check("runs from its start date", promotionRunsOn(rule(), "2026-01-01") && !promotionRunsOn(rule(), "2025-12-31"));
check("stops after its end date", promotionRunsOn(rule({ ends_on: "2026-06-30" }), "2026-06-30") && !promotionRunsOn(rule({ ends_on: "2026-06-30" }), "2026-07-01"));

const bought = new Map([["A", 120], ["B", 500]]);
const rules = [rule(), rule({ id: "p2", product_id: "B", min_quantity: 200, free_quantity: 5, repeat_per_multiple: false })];
const e = earnedFreeGoods(rules, bought, "2026-10-23", false);
check("each product earns from its own promotion", e.length === 2 && e[0].quantity === 2 && e[1].quantity === 5, JSON.stringify(e));
check("Walk-in customers earn nothing", earnedFreeGoods(rules, bought, "2026-10-23", true).length === 0);
check("a promotion outside its dates earns nothing", earnedFreeGoods([rule({ ends_on: "2026-01-31" })], bought, "2026-10-23", false).length === 0);
check("products not bought earn nothing", earnedFreeGoods([rule({ product_id: "Z" })], bought, "2026-10-23", false).length === 0);

console.log(`\n${passed} promotion checks passed.`);
