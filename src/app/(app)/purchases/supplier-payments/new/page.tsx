import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { SupplierPaymentForm, type SupplierWithPayables } from "./payment-form";

export const metadata: Metadata = { title: "Record Supplier Payment" };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function NewSupplierPaymentPage(props: { searchParams: SP }) {
  await requirePermissionPage("purchases.record_payment");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const sp = await props.searchParams;
  const purchaseId = typeof sp.purchase === "string" ? sp.purchase : undefined;

  if (!ctx.branchId) return <div><PageHeader title="Record Supplier Payment" /><EmptyState title="No active branch" /></div>;
  const fxAllowed = can(ctx.user, "fx.settle") && await isFeatureEnabled(ctx.companyId, "fx_settlement");

  const [{ data: payables }, { data: suppliers }, { data: currencies }] = await Promise.all([
    admin.from("supplier_payables")
      .select("id, outstanding, fc_outstanding, currency_code, source_type, purchase_id, expense_id, supplier:suppliers(id, code, name), purchase:purchases(document_number, document_date), expense:expenses(document_number, document_date)")
      .eq("company_id", ctx.companyId).in("status", ["open", "partial"]),
    admin.from("suppliers").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    fxAllowed ? admin.from("currencies").select("code").eq("is_active", true).eq("is_functional", false).order("code") : Promise.resolve({ data: [] }),
  ]);

  // Every active supplier (advances can be paid before any invoice exists).
  const map = new Map<string, SupplierWithPayables>();
  for (const s of (suppliers ?? []) as { id: string; code: string; name: string }[]) map.set(s.id, { ...s, payables: [] });
  let initialSupplierId: string | undefined;
  for (const pb of payables ?? []) {
    const row = pb as unknown as {
      id: string; outstanding: number; fc_outstanding: number; currency_code: string; source_type: string;
      purchase_id: string | null; expense_id: string | null;
      supplier: { id: string; code: string; name: string } | null;
      purchase: { document_number: string | null; document_date: string } | null;
      expense: { document_number: string | null; document_date: string } | null;
    };
    const s = row.supplier;
    if (!s) continue;
    if (row.currency_code !== "TZS" && !fxAllowed) continue;
    const open = row.currency_code === "TZS" ? Number(row.outstanding) > 0 : Number(row.fc_outstanding) > 0;
    if (!open) continue;
    if (!map.has(s.id)) map.set(s.id, { id: s.id, code: s.code, name: s.name, payables: [] });
    const doc = row.source_type === "purchase" ? row.purchase : row.expense;
    map.get(s.id)!.payables.push({
      payable_id: row.id, label: doc?.document_number ?? "—", date: doc?.document_date ?? "", currency: row.currency_code,
      outstanding: Number(row.outstanding), fc_outstanding: Number(row.fc_outstanding),
    });
    if (purchaseId && row.purchase_id === purchaseId) initialSupplierId = s.id;
  }

  const { data: accounts } = await admin.from("payment_accounts").select("id, name, branch_id").eq("company_id", ctx.companyId).eq("is_active", true).order("code");
  const branchAccounts = (accounts ?? []).filter((a) => !a.branch_id || a.branch_id === ctx.branchId);

  return (
    <div>
      <PageHeader title="Record Supplier Payment" description="Pay outstanding purchases and expenses, or record a supplier advance. Payments always leave a TZS bank, cash or mobile-money account." />
      <SupplierPaymentForm branchId={ctx.branchId} suppliers={Array.from(map.values())} accounts={branchAccounts as never}
        initialSupplierId={initialSupplierId} fxAllowed={fxAllowed} currencies={((currencies ?? []) as { code: string }[]).map((c) => c.code)} />
    </div>
  );
}
