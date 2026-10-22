import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { RebagForm, type RebagInitial } from "../../rebag-form";
import { loadRebagOptions } from "../../options";

export const metadata: Metadata = { title: "Edit Rebagging Order" };
type Params = Promise<{ id: string }>;
const N = (v: unknown) => Number(v ?? 0);

export default async function EditRebagPage(props: { params: Params }) {
  await requirePermissionPage("rebagging.create");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "rebagging"))) return <div><PageHeader title="Edit Rebagging Order" /><EmptyState title="Rebagging is not enabled" /></div>;
  const { id } = await props.params;
  const admin = createAdminClient();
  const { data: o } = await admin.from("rebag_orders").select("*").eq("id", id).maybeSingle();
  if (!o || o.company_id !== ctx.companyId || (!ctx.user.isOwner && !ctx.user.branchIds.includes(o.branch_id))) notFound();
  if (!["draft", "issued"].includes(o.document_status)) {
    return <div><PageHeader title="Edit Rebagging Order" /><EmptyState title={`A ${o.document_status} order cannot be edited`} /></div>;
  }
  const [{ data: inputs }, { data: outputs }, { data: charges }, options] = await Promise.all([
    admin.from("rebag_inputs").select("input_kind, product_id, quantity, damaged_qty, qty_per_bag, target_output_id, lot_id").eq("order_id", id).order("line_no"),
    admin.from("rebag_outputs").select("id, product_id, bags").eq("order_id", id).order("line_no"),
    admin.from("cost_sources").select("cost_category_id, description, estimated_amount, allocation_basis, status").eq("rebag_order_id", id).eq("status", "estimated"),
    loadRebagOptions(ctx),
  ]);
  const ins = inputs ?? [];
  const initial: RebagInitial = {
    id, status: o.document_status, branchId: o.branch_id, bulkProductId: o.bulk_product_id, shipmentId: o.import_shipment_id,
    orderDate: o.order_date, location: o.location ?? "", operatorName: o.operator_name ?? "", notes: o.notes ?? "",
    returnedKg: N(o.returned_kg), normalLossKg: N(o.normal_loss_kg), abnormalLossKg: N(o.abnormal_loss_kg),
    bulkLines: ins.filter((i) => i.input_kind === "bulk").map((i) => ({ lot_id: i.lot_id, kg: N(i.quantity) })),
    outputs: (outputs ?? []).map((x) => ({ id: x.id, product_id: x.product_id, bags: N(x.bags) })),
    packaging: ins.filter((i) => i.input_kind === "packaging").map((i) => ({
      product_id: i.product_id, quantity: N(i.quantity), damaged_qty: N(i.damaged_qty), qty_per_bag: i.qty_per_bag == null ? null : N(i.qty_per_bag), target_id: i.target_output_id,
    })),
    charges: (charges ?? []).map((c) => ({ category_id: c.cost_category_id, description: c.description ?? "", amount: N(c.estimated_amount), basis: c.allocation_basis })),
  };
  return (
    <div>
      <PageHeader title={`${o.document_status === "issued" ? "Record results" : "Edit"} · ${o.document_number ?? "draft"}`}
        description={o.document_status === "issued" ? "Record the good bags, unused bulk, losses, packaging used and charges, then complete the order." : undefined} />
      <RebagForm options={options} initial={initial} defaultBranchId={o.branch_id} />
    </div>
  );
}
