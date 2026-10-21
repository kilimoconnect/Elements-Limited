import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { flattenProducts } from "@/lib/products";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { PurchaseForm, type AdvanceOpt } from "./purchase-form";

export const metadata: Metadata = { title: "Create Purchase" };

export default async function NewPurchasePage() {
  await requirePermissionPage("purchases.create");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  if (!ctx.branchId) return <div><PageHeader title="Create Purchase" /><EmptyState title="No active branch" /></div>;

  const fxAllowed = can(ctx.user, "fx.enter_rate") && await isFeatureEnabled(ctx.companyId, "fx_settlement");

  const [{ data: products }, { data: taxCodes }, { data: accounts }, { data: suppliers }, { data: currencies }, { data: rates }, { data: advances }] = await Promise.all([
    admin.from("products").select("id, sku, barcode, name, tax_code_id, category:product_categories(name), brand:brands(name)").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("tax_codes").select("id, name, rate, is_inclusive").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("payment_accounts").select("id, name, branch_id").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("suppliers").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    fxAllowed ? admin.from("currencies").select("code, name").eq("is_active", true).eq("is_functional", false).order("code") : Promise.resolve({ data: [] }),
    fxAllowed ? admin.from("exchange_rates").select("currency_code, rate_date, rate").eq("company_id", ctx.companyId).order("rate_date", { ascending: false }).limit(1000) : Promise.resolve({ data: [] }),
    admin.from("supplier_advances").select("id, supplier_id, currency_code, fc_remaining, advance_date, payment:supplier_payments(document_number)").eq("company_id", ctx.companyId).eq("status", "open").gt("fc_remaining", 0),
  ]);
  const branchAccounts = (accounts ?? []).filter((a) => !a.branch_id || a.branch_id === ctx.branchId);
  const advanceOpts: AdvanceOpt[] = ((advances ?? []) as unknown as Array<{ id: string; supplier_id: string; currency_code: string; fc_remaining: number; advance_date: string; payment: { document_number: string | null } | null }>)
    .filter((a) => a.currency_code === "TZS" || fxAllowed)
    .map((a) => ({ id: a.id, supplier_id: a.supplier_id, currency_code: a.currency_code, fc_remaining: Number(a.fc_remaining), label: `Advance ${a.payment?.document_number ?? ""} (${a.advance_date})` }));

  return (
    <div>
      <PageHeader title="Create Purchase" description="Record received goods and the supplier invoice. Save as draft if goods are not yet received." />
      <PurchaseForm branchId={ctx.branchId}
        products={flattenProducts(products)}
        taxCodes={(taxCodes ?? []).map((t) => ({ ...t, rate: Number(t.rate) })) as never}
        accounts={branchAccounts as never} suppliers={(suppliers ?? []) as never}
        currencies={(currencies ?? []) as never} fxAllowed={fxAllowed}
        tableRates={((rates ?? []) as Array<{ currency_code: string; rate_date: string; rate: number }>).map((r) => ({ currency: r.currency_code, date: r.rate_date, rate: Number(r.rate) }))}
        advances={advanceOpts} />
    </div>
  );
}
