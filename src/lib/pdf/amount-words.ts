/**
 * Amounts in words for documents, e.g.
 *   76,560,000.00 -> "Seventy-Six Million Five Hundred Sixty Thousand Tanzanian Shillings Only"
 *   1,250.50      -> "One Thousand Two Hundred Fifty Tanzanian Shillings and Fifty Cents Only"
 */
const ONES = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const SCALES = ["", "Thousand", "Million", "Billion", "Trillion"];

function belowThousand(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100), r = n % 100;
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? `-${ONES[r % 10]}` : ""));
  return parts.join(" ");
}

/** Whole number in words ("Zero" for 0). */
export function numberToWords(value: number): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return "Zero";
  const groups: string[] = [];
  let i = 0;
  while (n > 0 && i < SCALES.length) {
    const g = n % 1000;
    if (g) groups.unshift(`${belowThousand(g)}${SCALES[i] ? ` ${SCALES[i]}` : ""}`);
    n = Math.floor(n / 1000); i++;
  }
  return groups.join(" ");
}

/** A money amount in words, with cents when there are any. */
export function amountInWords(value: number, currency = "Tanzanian Shillings", minor = "Cents"): string {
  const cents = Math.round(Math.abs(value) * 100) % 100;
  const whole = Math.floor(Math.round(Math.abs(value) * 100) / 100);
  return `${value < 0 ? "Minus " : ""}${numberToWords(whole)} ${currency}${cents ? ` and ${numberToWords(cents)} ${minor}` : ""} Only`;
}
