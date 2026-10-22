import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { CostInvoiceForm, type SourceOpt } from "./cost-invoice-form";

export const metadata: Metadata = { title: "New Cost Invoice" };
type SearchParams = Promise<{ shipment?: string }>;

export default async function NewCostInvoicePage(props: { searchParams: SearchParams }) {
  await requirePermissionPage("cost_invoices.post");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "imports"))) {
    return <div><PageHeader title="New Cost Invoice" /><EmptyState title="Importation is not enabled" /></div>;
  }
  const { shipment } = await props.searchParams;
  const admin = createAdminClient();
  const [{ data: suppliers }, { data: categories }, { data: taxCodes }, { data: sources }, { data: invoices }] = await Promise.all([
    admin.from("suppliers").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("cost_categories").select("id, code, name, inventory_treatment, default_tax_code_id").eq("company_id", ctx.companyId)
      .eq("is_active", true).or("applies_to_import.eq.true,applies_to_rebagging.eq.true").eq("is_goods_value", false).order("code"),
    admin.from("tax_codes").select("id, name, rate, is_recoverable").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("cost_sources").select("id, cost_category_id, description, status, estimated_amount, accrued_amount, actual_amount, supplier_id, import_shipment:import_shipments(id, document_number, logistics_status), rebag_order:rebag_orders(id, document_number, document_status)")
      .eq("company_id", ctx.companyId).in("owner_type", ["import_shipment", "rebag_order"]).neq("status", "voided"),
    admin.from("cost_invoices").select("id, document_number, supplier_id, grand_total").eq("company_id", ctx.companyId)
      .eq("document_status", "posted").eq("document_kind", "invoice").order("document_date", { ascending: false }).limit(500),
  ]);
  type Src = { id: string; cost_category_id: string; description: string | null; status: string; estimated_amount: number; accrued_amount: number; actual_amount: number;
    supplier_id: string | null; import_shipment: { id: string; document_number: string | null; logistics_status: string } | null;
    rebag_order: { id: string; document_number: string | null; document_status: string } | null };
  const opts: SourceOpt[] = ((sources ?? []) as unknown as Src[])
    // Shipment costs, and rebagging charges once their order is completed (they are accrued at completion).
    .filter((s) => (s.import_shipment && s.import_shipment.logistics_status !== "cancelled") || s.rebag_order?.document_status === "completed")
    .map((s) => ({
      id: s.id, categoryId: s.cost_category_id, status: s.status, shipmentId: s.import_shipment?.id ?? "", supplierId: s.supplier_id,
      label: s.import_shipment ? `${s.import_shipment.document_number ?? "—"} · ${s.description ?? "cost"}` : `Rebagging ${s.rebag_order!.document_number ?? "—"} · ${s.description ?? "charge"}`,
      estimate: Number(s.estimated_amount), accrued: Number(s.accrued_amount), actual: Number(s.actual_amount),
    }));
  return (
    <div>
      <PageHeader title="New Cost Invoice" description="Post a service supplier's invoice (TZS). Each capitalised line closes one shipment cost or rebagging charge; only the difference from its accrual changes stock cost." />
      <CostInvoiceForm
        suppliers={(suppliers ?? []).map((s) => ({ id: s.id, label: `${s.code} — ${s.name}` }))}
        branches={ctx.branches.filter((b) => ctx.user.isOwner || ctx.user.branchIds.includes(b.id)).map((b) => ({ id: b.id, label: `${b.code} — ${b.name}` }))}
        defaultBranchId={ctx.branchId ?? ctx.branches[0]?.id ?? ""}
        categories={(categories ?? []).map((c) => ({ id: c.id, label: `${c.code} — ${c.name}`, capitalise: c.inventory_treatment === "capitalize", taxCodeId: c.default_tax_code_id }))}
        taxCodes={(taxCodes ?? []).map((t) => ({ id: t.id, name: t.name, rate: Number(t.rate), recoverable: t.is_recoverable }))}
        sources={opts} shipmentId={shipment ?? null}
        invoices={(invoices ?? []).map((i) => ({ id: i.id, supplierId: i.supplier_id, label: `${i.document_number ?? "—"} (${Number(i.grand_total).toLocaleString("en-US")})` }))} />
    </div>
  );
}
