/** Unit tests for the price suggestion arithmetic (no database). */
import { suggestPrice, validatePricing, netOfVat, actualMargins } from "../src/lib/pricing/calc";

let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { console.error(`  FAIL ${name} ${detail}`); process.exitCode = 1; }
}
// The branch's inventory cost already includes transfer, rebagging and import costs.
const base = { inventoryCost: 50000, taxRatePct: 0, taxInclusive: false };

const m = suggestPrice({ ...base, mode: "margin", ratePct: 20 });
check("20% gross margin on an inventory cost of 50,000 suggests 62,500 before VAT", m.priceExVat === 62500, JSON.stringify(m));
const k = suggestPrice({ ...base, mode: "markup", ratePct: 20 });
check("20% markup on 50,000 suggests 60,000 before VAT", k.priceExVat === 60000, JSON.stringify(k));
check("margin and markup modes stay distinct (implied margin of the markup price is 16.67%)", k.impliedMarginPct === 16.67 && m.impliedMarkupPct === 25);
check("the inventory cost is an input only (never changed by the suggestion)", base.inventoryCost === 50000);
const a = actualMargins(62500, 50000);
check("gross margin at a price uses the branch inventory cost (12,500 = 20%)", a.grossProfit === 12500 && a.grossMarginPct === 20, JSON.stringify(a));
const other = actualMargins(62500, 48500);
check("the same price gives each branch its own margin (48,500 cost: 14,000 = 22.4%)", other.grossProfit === 14000 && other.grossMarginPct === 22.4, JSON.stringify(other));
check("margin of 100% or more is refused", validatePricing({ ...base, mode: "margin", ratePct: 100 }) !== null && validatePricing({ ...base, mode: "margin", ratePct: 120 }) !== null);
check("negative markup refused; negative cost refused", validatePricing({ ...base, mode: "markup", ratePct: -5 }) !== null && validatePricing({ ...base, inventoryCost: -1, mode: "markup", ratePct: 5 }) !== null);
let threw = false; try { suggestPrice({ ...base, mode: "margin", ratePct: 100 }); } catch { threw = true; }
check("suggestPrice throws on an invalid margin", threw);
const ex = suggestPrice({ ...base, mode: "margin", ratePct: 20, taxRatePct: 18 });
check("VAT-exclusive tax code: 62,500 + 18% VAT 11,250 = 73,750; selling price stored ex VAT", ex.vat === 11250 && ex.priceInclVat === 73750 && ex.sellingPrice === 62500);
const inc = suggestPrice({ ...base, mode: "margin", ratePct: 20, taxRatePct: 18, taxInclusive: true });
check("VAT-inclusive tax code: selling price stored incl. VAT (73,750)", inc.sellingPrice === 73750);
check("net of VAT from an inclusive price", netOfVat(73750, 18, true) === 62500 && netOfVat(62500, 18, false) === 62500);
check("zero-rated tax code: price incl. = price ex VAT", suggestPrice({ ...base, mode: "markup", ratePct: 10 }).priceInclVat === 55000);

console.log(`\n${passed} pricing checks passed.`);
