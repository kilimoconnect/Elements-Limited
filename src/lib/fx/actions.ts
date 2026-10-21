"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { writeAuditLog } from "@/lib/audit";
import { callPostingRpc, type RpcResult } from "@/lib/rpc";
import { validateRate } from "./rates";

export interface ClosingRateInput { currency: string; rate: number; source: "manual" | "rate_table"; reference?: string }

/** Period-end revaluation of open foreign purchase payables and supplier credits. */
export async function postFxRevaluation(input: { date: string; rates: ClosingRateInput[]; requestId?: string }): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "fx.revalue");
    const ctx = await getActiveContext();
    if (!(await isFeatureEnabled(ctx.companyId, "fx_settlement"))) return { ok: false, error: "Foreign-currency settlement is not enabled." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { ok: false, error: "Choose the revaluation date." };
    for (const r of input.rates) {
      const v = await validateRate(ctx.companyId, r.currency, input.date, r.rate, r.source);
      if (!v.ok) return { ok: false, error: `${r.currency}: ${v.error}` };
    }
    const res = await callPostingRpc("post_fx_revaluation", {
      p_company: ctx.companyId, p_date: input.date,
      p_rates: input.rates.map((r) => ({ currency: r.currency, rate: r.rate, source: r.source, reference: r.reference || null })),
      p_user: user.id, p_idem: input.requestId ?? `post_fx_revaluation:${randomUUID()}`,
    });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "fx.revaluation_post", resourceType: "fx_revaluation", resourceId: res.id, newValues: { date: input.date, rates: input.rates } });
      ["/accounting/fx-revaluation", "/reports/payables-ageing", "/reports/supplier-statements", "/purchases/history"].forEach((p) => revalidatePath(p));
    }
    return res;
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}

export async function voidFxRevaluation(id: string, reason: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "fx.revalue");
    const ctx = await getActiveContext();
    if (!reason?.trim()) return { ok: false, error: "A reason is required." };
    const res = await callPostingRpc("void_fx_revaluation", { p_id: id, p_user: user.id, p_reason: reason });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "fx.revaluation_void", resourceType: "fx_revaluation", resourceId: id, reason });
      ["/accounting/fx-revaluation", "/reports/payables-ageing", "/reports/supplier-statements"].forEach((p) => revalidatePath(p));
    }
    return res;
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}
