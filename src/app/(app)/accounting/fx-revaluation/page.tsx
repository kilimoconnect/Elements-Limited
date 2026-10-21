import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { RevaluationForm, type OpenBalance, type RevaluationRow, type TableRate } from "./revaluation-form";

export const metadata: Metadata = { title: "FX Revaluation" };

export default async function FxRevaluationPage() {
  await requirePermissionPage("fx.revalue");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "fx_settlement"))) {
    return <div><PageHeader title="FX Revaluation" /><EmptyState title="Foreign-currency settlement is not enabled" description="Enable it under Admin → Feature Flags." /></div>;
  }
  const admin = createAdminClient();
  const [{ data: payables }, { data: credits }, { data: rates }, { data: history }] = await Promise.all([
    admin.from("supplier_payables").select("currency_code, fc_outstanding, outstanding")
      .eq("company_id", ctx.companyId).neq("currency_code", "TZS").in("status", ["open", "partial"]).gt("fc_outstanding", 0),
    admin.from("supplier_credits").select("currency_code, fc_remaining, remaining")
      .eq("company_id", ctx.companyId).neq("currency_code", "TZS").eq("status", "open").gt("fc_remaining", 0),
    admin.from("exchange_rates").select("currency_code, rate_date, rate").eq("company_id", ctx.companyId).order("rate_date", { ascending: false }).limit(1000),
    admin.from("fx_revaluations").select("id, document_number, revaluation_date, status, total_loss, total_gain")
      .eq("company_id", ctx.companyId).order("revaluation_date", { ascending: false }).limit(50),
  ]);
  const balances: OpenBalance[] = [
    ...((payables ?? []) as Array<{ currency_code: string; fc_outstanding: number; outstanding: number }>)
      .map((p) => ({ currency: p.currency_code, kind: "payable" as const, fc: Number(p.fc_outstanding), carrying: Number(p.outstanding) })),
    ...((credits ?? []) as Array<{ currency_code: string; fc_remaining: number; remaining: number }>)
      .map((c) => ({ currency: c.currency_code, kind: "credit" as const, fc: Number(c.fc_remaining), carrying: Number(c.remaining) })),
  ];
  const tableRates: TableRate[] = ((rates ?? []) as Array<{ currency_code: string; rate_date: string; rate: number }>)
    .map((r) => ({ currency: r.currency_code, date: r.rate_date, rate: Number(r.rate) }));

  return (
    <div>
      <PageHeader title="FX Revaluation"
        description="Period-end revaluation of open foreign-currency supplier invoices and credits at authorised closing rates." />
      <RevaluationForm balances={balances} tableRates={tableRates}
        history={((history ?? []) as RevaluationRow[]).map((h) => ({ ...h, total_loss: Number(h.total_loss), total_gain: Number(h.total_gain) }))} />
    </div>
  );
}
