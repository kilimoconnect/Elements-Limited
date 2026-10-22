/**
 * Price suggestion arithmetic (pure; no database). The cost is the branch's
 * inventory cost: the posted weighted-average cost per unit, which already
 * includes every capitalised cost (goods, import costs, rebagging, transfer
 * loading / transport / offloading). Nothing is added on top.
 *
 *   markup mode: price before tax = inventory cost x (1 + markup)
 *   margin mode: price before tax = inventory cost / (1 - margin)   (margin < 100%)
 *
 * VAT follows the SKU's tax code: an exclusive code adds VAT on top; an
 * inclusive code means the selling price already contains VAT.
 */

export type PricingMode = "markup" | "margin";

export interface PricingInput {
  inventoryCost: number;        // the branch's weighted-average cost per unit (TZS)
  mode: PricingMode;
  ratePct: number;              // markup % or gross-margin %
  taxRatePct: number;           // the SKU's tax code rate
  taxInclusive: boolean;        // the SKU's tax code is VAT-inclusive
}

export interface PricingResult {
  priceExVat: number;
  vat: number;
  priceInclVat: number;
  /** the figure to store as the selling price, in the tax code's convention */
  sellingPrice: number;
  /** margin and markup implied by the suggested price on the inventory cost */
  impliedMarginPct: number;
  impliedMarkupPct: number;
}

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export function validatePricing(i: PricingInput): string | null {
  if (!Number.isFinite(i.inventoryCost) || i.inventoryCost < 0) return "Inventory cost must be zero or more.";
  if (!Number.isFinite(i.ratePct)) return "Enter a rate.";
  if (i.mode === "margin" && (i.ratePct < 0 || i.ratePct >= 100)) return "Gross margin must be at least 0% and below 100%.";
  if (i.mode === "markup" && i.ratePct < 0) return "Markup cannot be negative.";
  if (!Number.isFinite(i.taxRatePct) || i.taxRatePct < 0) return "Invalid tax rate.";
  return null;
}

export function suggestPrice(i: PricingInput): PricingResult {
  const err = validatePricing(i);
  if (err) throw new Error(err);
  const cost = r2(i.inventoryCost);
  const priceExVat = r2(i.mode === "markup" ? cost * (1 + i.ratePct / 100) : cost / (1 - i.ratePct / 100));
  const vat = r2(priceExVat * i.taxRatePct / 100);
  const priceInclVat = r2(priceExVat + vat);
  return {
    priceExVat, vat, priceInclVat,
    sellingPrice: i.taxInclusive ? priceInclVat : priceExVat,
    impliedMarginPct: priceExVat > 0 ? r2((priceExVat - cost) / priceExVat * 100) : 0,
    impliedMarkupPct: cost > 0 ? r2((priceExVat - cost) / cost * 100) : 0,
  };
}

/** Net (ex-VAT) price from a stored selling price under a tax code. */
export function netOfVat(sellingPrice: number, taxRatePct: number, taxInclusive: boolean): number {
  return taxInclusive && taxRatePct > 0 ? r2(sellingPrice / (1 + taxRatePct / 100)) : r2(sellingPrice);
}

/** Gross profit and margin at a net price against a branch's inventory cost. */
export function actualMargins(netPrice: number, inventoryCost: number) {
  const gross = r2(netPrice - inventoryCost);
  return { grossProfit: gross, grossMarginPct: netPrice > 0 ? r2(gross / netPrice * 100) : 0 };
}
