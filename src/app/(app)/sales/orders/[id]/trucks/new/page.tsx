import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { loadOrder } from "@/lib/sales/fulfilment-data";
import { canUseLicenceNumber } from "@/lib/transfers/licence";
import { TruckForm } from "./truck-form";

export const metadata: Metadata = { title: "New Truck" };

export default async function NewTruckPage(props: { params: Promise<{ id: string }> }) {
  await requirePermissionPage("sales.fulfil");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();
  const { o, lines } = await loadOrder(admin, ctx.user, ctx.companyId, id);
  if (!["approved", "in_fulfilment"].includes(o.status) || o.on_hold) redirect(`/sales/orders/${id}`);
  const goods = lines.filter((l) => l.track_inventory);
  const kg: Record<string, number | null> = {};
  for (const l of goods) {
    if (l.product_id in kg) continue;
    const { data } = await admin.rpc("_kg_per_unit", { p_product: l.product_id });
    kg[l.product_id] = data === null ? null : Number(data);
  }
  return (
    <div>
      <PageHeader title={`New truck for ${o.document_number}`} description={`${o.customer?.name ?? ""} · ${o.fulfilment_mode === "delivery" ? `Delivery to ${o.destination ?? ""}` : "Customer collects"}`} />
      <TruckForm orderId={o.id} mode={o.fulfilment_mode} canLicence={canUseLicenceNumber(ctx.user)}
        defaults={{ destination: o.destination ?? "", consignee_name: o.consignee_name ?? "", consignee_phone: o.consignee_phone ?? "", dispatch_location: o.fulfilment_location ?? "" }}
        lines={goods.map((l) => ({
          id: l.id, description: l.description ?? l.product?.name ?? "", sku: l.product?.sku ?? "", unit: l.product?.unit?.code ?? "",
          remaining: Math.max(Number(l.quantity) - Number(l.qty_dispatched) - Number(l.qty_allocated), 0), kgPerUnit: kg[l.product_id] ?? null,
        }))} />
    </div>
  );
}
