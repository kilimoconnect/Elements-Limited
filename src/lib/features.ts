import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Per-company feature flags (migration 0025, default OFF). New import /
 * rebagging / transfer-logistics workflows stay hidden and their database
 * functions refuse to run until the Owner enables the flag.
 */
export const FEATURE_FLAGS = ["imports", "rebagging", "transfer_logistics", "attachments", "fx_settlement"] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export async function isFeatureEnabled(companyId: string, flag: FeatureFlag): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin.from("feature_flags").select("is_enabled")
    .eq("company_id", companyId).eq("flag_key", flag).maybeSingle();
  return data?.is_enabled === true;
}
