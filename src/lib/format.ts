/**
 * Display formatting for the company locale.
 * Base currency TZS, timezone Africa/Dar_es_Salaam, dates DD/MM/YYYY.
 */

export const COMPANY_TIMEZONE = "Africa/Dar_es_Salaam";
export const BASE_CURRENCY = "TZS";

const moneyFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "TZS 1,234,567.00" - comma separators, two decimals. */
export function formatMoney(
  value: number | string | null | undefined,
  currency: string = BASE_CURRENCY,
): string {
  const n = typeof value === "string" ? Number(value) : value ?? 0;
  const safe = Number.isFinite(n) ? (n as number) : 0;
  return `${currency} ${moneyFormatter.format(safe)}`;
}

/** "1,234.5000" - thousands separated, up to 4 decimals (quantities). */
export function formatQuantity(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value ?? 0;
  const safe = Number.isFinite(n) ? (n as number) : 0;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(safe);
}

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: COMPANY_TIMEZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: COMPANY_TIMEZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "DD/MM/YYYY" in company timezone. */
export function formatDate(value: Date | string | number | null | undefined): string {
  const d = toDate(value);
  return d ? dateFormatter.format(d) : "-";
}

/** "DD/MM/YYYY, HH:mm" in company timezone. */
export function formatDateTime(
  value: Date | string | number | null | undefined,
): string {
  const d = toDate(value);
  return d ? dateTimeFormatter.format(d) : "-";
}

const isoDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: COMPANY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's date (YYYY-MM-DD) in the company timezone, not UTC. */
export function todayISO(): string {
  return isoDateFormatter.format(new Date());
}

// Africa/Dar_es_Salaam is UTC+03:00 all year (no daylight saving).
const COMPANY_UTC_OFFSET = "+03:00";

/** First instant of a company-local day, for timestamp filters. */
export function localDayStart(isoDate: string): string {
  return `${isoDate}T00:00:00${COMPANY_UTC_OFFSET}`;
}

/** Last instant of a company-local day, for timestamp filters. */
export function localDayEnd(isoDate: string): string {
  return `${isoDate}T23:59:59.999${COMPANY_UTC_OFFSET}`;
}
