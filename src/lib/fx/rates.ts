import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Exchange-rate validation shared by purchase and payment actions. Rates are
 * TZS per 1 unit of the foreign currency, positive, at most 6 decimals. A
 * "rate_table" source must equal the latest Admin > Exchange Rates entry on or
 * before the date; "manual" rates are allowed for users with fx.enter_rate.
 * The database re-checks all of this at posting.
 */
export async function validateRate(
  companyId: string, currency: string, date: string, rate: number | undefined, source: "manual" | "rate_table" | null,
): Promise<{ ok: true; rate: number } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const { data: cur } = await admin.from("currencies").select("code, is_active, is_functional").eq("code", currency).maybeSingle();
  if (!cur || !cur.is_active || cur.is_functional) return { ok: false, error: `Currency ${currency} is not available for foreign purchases.` };
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return { ok: false, error: "Enter a positive exchange rate (TZS per 1 unit)." };
  if (Math.round(rate * 1e6) / 1e6 !== rate) return { ok: false, error: "Exchange rates can have at most 6 decimals." };
  if (!source) return { ok: false, error: "Record where the exchange rate comes from." };
  if (source === "rate_table") {
    const table = await tableRate(companyId, currency, date);
    if (table === null) return { ok: false, error: `No ${currency} rate in the exchange-rate table on or before this date.` };
    if (table !== rate) return { ok: false, error: `The rate does not match the exchange-rate table (${table}).` };
  }
  return { ok: true, rate };
}

/** Latest Admin rate on or before a date, or null. */
export async function tableRate(companyId: string, currency: string, date: string): Promise<number | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("exchange_rates").select("rate").eq("company_id", companyId)
    .eq("currency_code", currency).lte("rate_date", date).order("rate_date", { ascending: false }).limit(1).maybeSingle();
  return data ? Number(data.rate) : null;
}
