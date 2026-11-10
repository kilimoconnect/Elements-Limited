/**
 * Phone numbers are saved in one standard form (database trigger, migration 0062):
 *   "0687 322 677", "0687-322-677", "+255 687 322 677", "255687322677", "687322677"  ->  "0687322677"
 *   "+254 712 345 678", "00254712345678", "254712345678"                             ->  "+254712345678"
 * Tanzanian numbers use the local 0 + 9 digits form; other countries keep + and the
 * country code. Several numbers in one field ("0687 322 677 / 0712 345 678") are each
 * corrected and kept, separated by " / ". Keep in step with public.normalise_phone().
 */
export function normalisePhone(value: string | null | undefined): string {
  const raw = (value ?? "").normalize("NFKC").trim();
  if (!raw) return "";
  const parts = raw.split(/\s*(?:[\/,;&]|\bor\b|\band\b)\s*/i).map(one).filter(Boolean);
  return parts.join(" / ");
}

function one(part: string): string {
  const intl = /^\s*(\+|00)/.test(part);
  let d = part.replace(/\D/g, "");
  if (!d) return "";
  if (intl && part.trim().startsWith("00")) d = d.slice(2);
  // Tanzania: +255 / 255, with or without a stray 0 after the code.
  if (d.startsWith("2550") && d.length === 13) return `0${d.slice(4)}`;
  if (d.startsWith("255") && d.length === 12) return `0${d.slice(3)}`;
  if (intl) return `+${d}`;
  // Local number typed without its 0 ("687 322 677").
  if (d.length === 9 && d[0] !== "0") return `0${d}`;
  // A foreign number typed with its country code but no + ("254712345678").
  if (d.length >= 11 && d[0] !== "0") return `+${d}`;
  return d;
}
