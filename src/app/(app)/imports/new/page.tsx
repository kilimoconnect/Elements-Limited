import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { flattenProducts } from "@/lib/products";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ShipmentForm } from "./shipment-form";

export const metadata: Metadata = { title: "New Import Shipment" };

export default async function NewShipmentPage() {
  await requirePermissionPage("imports.create");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "imports"))) {
    return <div><PageHeader title="New Import Shipment" /><EmptyState title="Importation is not enabled" /></div>;
  }
  const admin = createAdminClient();
  const fx = await isFeatureEnabled(ctx.companyId, "fx_settlement");
  const [{ data: suppliers }, { data: products }, { data: currencies }] = await Promise.all([
    admin.from("suppliers").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    // Imports bring bulk, standard items or packaging materials - never packaged bags.
    admin.from("products").select("id, sku, barcode, name, stock_role, track_inventory, category:product_categories(name), brand:brands(name)")
      .eq("company_id", ctx.companyId).eq("is_active", true).eq("track_inventory", true).neq("stock_role", "packaged").order("name"),
    fx ? admin.from("currencies").select("code").eq("is_active", true).eq("is_functional", false).order("code") : Promise.resolve({ data: [] }),
  ]);
  return (
    <div>
      <PageHeader title="New Import Shipment" description="Goods are received into bulk stock; bags are produced later by rebagging." />
      <ShipmentForm
        suppliers={(suppliers ?? []).map((s) => ({ id: s.id, label: `${s.code} — ${s.name}` }))}
        branches={ctx.branches.map((b) => ({ id: b.id, label: `${b.code} — ${b.name}` }))}
        products={flattenProducts(products) as never}
        currencies={((currencies ?? []) as { code: string }[]).map((c) => c.code)}
        defaultBranchId={ctx.branchId ?? ctx.branches[0]?.id ?? ""} />
    </div>
  );
}
