/**
 * Price suggestion arithmetic (pure; no database). Accounting cost and
 * commercial overhead stay separate: the overhead only raises the pricing
 * cost used for the suggestion; it is never posted to inventory or expense.
 *
 *   pricing cost = accounting cost + commercial overhead
 *   markup mode: price before tax = pricing cost x (1 + markup)
 *   margin mode: price before tax = pricing cost / (1 - margin)   (margin < 100%)
 *
 * VAT follows the SKU's tax code: an exclusive code adds VAT on top; an
 * inclusive code means the selling price already contains VAT.
 */

export type PricingMode = "markup" | "margin";

export interface PricingInput {
  accountingCost: number;       // current weighted-average cost per unit (TZS)
  commercialOverhead: number;   // per unit, not in inventory cost (storage, overheads ...)
  mode: PricingMode;
  ratePct: number;              // markup % or gross-margin %
  taxRatePct: number;           // the SKU's tax code rate
  taxInclusive: boolean;        // the SKU's tax code is VAT-inclusive
}

export interface PricingResult {
  pricingCost: number;
  priceExVat: number;
  vat: number;
  priceInclVat: number;
  /** the figure to store as the selling price, in the tax code's convention */
  sellingPrice: number;
  /** margin and markup implied by the suggested price on the pricing cost */
  impliedMarginPct: number;
  impliedMarkupPct: number;
}

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export function validatePricing(i: PricingInput): string | null {
  if (!Number.isFinite(i.accountingCost) || i.accountingCost < 0) return "Accounting cost must be zero or more.";
  if (!Number.isFinite(i.commercialOverhead) || i.commercialOverhead < 0) return "Commercial overhead must be zero or more.";
  if (!Number.isFinite(i.ratePct)) return "Enter a rate.";
  if (i.mode === "margin" && (i.ratePct < 0 || i.ratePct >= 100)) return "Gross margin must be at least 0% and below 100%.";
  if (i.mode === "markup" && i.ratePct < 0) return "Markup cannot be negative.";
  if (!Number.isFinite(i.taxRatePct) || i.taxRatePct < 0) return "Invalid tax rate.";
  return null;
}

export function suggestPrice(i: PricingInput): PricingResult {
  const err = validatePricing(i);
  if (err) throw new Error(err);
  const pricingCost = r2(i.accountingCost + i.commercialOverhead);
  const priceExVat = r2(i.mode === "markup" ? pricingCost * (1 + i.ratePct / 100) : pricingCost / (1 - i.ratePct / 100));
  const vat = r2(priceExVat * i.taxRatePct / 100);
  const priceInclVat = r2(priceExVat + vat);
  return {
    pricingCost, priceExVat, vat, priceInclVat,
    sellingPrice: i.taxInclusive ? priceInclVat : priceExVat,
    impliedMarginPct: priceExVat > 0 ? r2((priceExVat - pricingCost) / priceExVat * 100) : 0,
    impliedMarkupPct: pricingCost > 0 ? r2((priceExVat - pricingCost) / pricingCost * 100) : 0,
  };
}

/** Net (ex-VAT) price from a stored selling price under a tax code. */
export function netOfVat(sellingPrice: number, taxRatePct: number, taxInclusive: boolean): number {
  return taxInclusive && taxRatePct > 0 ? r2(sellingPrice / (1 + taxRatePct / 100)) : r2(sellingPrice);
}

/**
 * Actual results at a price: gross margin uses the accounting cost (what the
 * books will show); commercial contribution also deducts the overhead.
 */
export function actualMargins(netPrice: number, accountingCost: number, commercialOverhead: number) {
  const gross = r2(netPrice - accountingCost);
  const contribution = r2(gross - commercialOverhead);
  return {
    grossProfit: gross,
    grossMarginPct: netPrice > 0 ? r2(gross / netPrice * 100) : 0,
    commercialContribution: contribution,
    contributionPct: netPrice > 0 ? r2(contribution / netPrice * 100) : 0,
  };
}
