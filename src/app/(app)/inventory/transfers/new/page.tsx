import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { NewTransferForm } from "./new-transfer-form";

export const metadata: Metadata = { title: "New Transfer" };

export default async function NewTransferPage() {
  await requirePermissionPage("inventory.transfer_create");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const [{ data: products }, { data: categories }, logistics] = await Promise.all([
    admin.from("products").select("id, sku, name").eq("company_id", ctx.companyId).eq("is_active", true).order("sku"),
    // Only charge types that go into inventory cost.
    admin.from("cost_categories").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true)
      .eq("applies_to_transfer", true).eq("inventory_treatment", "capitalize").order("code"),
    isFeatureEnabled(ctx.companyId, "transfer_logistics"),
  ]);
  const myBranches = ctx.user.isOwner ? ctx.branches : ctx.branches.filter((b) => ctx.user.branchIds.includes(b.id));
  return (
    <div>
      <PageHeader title="New Transfer"
        description="Goods, truck and driver, and the loading, transport and other charges for this move. Charges are added to the cost of the goods at the receiving branch; offloading is entered when the goods are received." />
      {!ctx.branchId || myBranches.length === 0 ? <EmptyState title="Choose a branch first" /> : (
        <NewTransferForm
          products={(products ?? []) as never}
          sourceBranches={myBranches}
          allBranches={ctx.branches}
          sourceBranchId={ctx.branchId}
          canDispatch={can(ctx.user, "inventory.transfer_dispatch")}
          canLicence={can(ctx.user, "documents.view_licence")}
          chargesEnabled={logistics}
          categories={(categories ?? []).map((c) => ({ id: c.id, code: c.code, label: c.name }))}
        />
      )}
    </div>
  );
}
