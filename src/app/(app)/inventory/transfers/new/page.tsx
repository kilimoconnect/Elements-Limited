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
  const [{ data: products }, { data: categories }, logistics, { data: companyBranches }] = await Promise.all([
    admin.from("products").select("id, sku, name").eq("company_id", ctx.companyId).eq("is_active", true).order("sku"),
    // Only charge types that go into inventory cost.
    admin.from("cost_categories").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true)
      .eq("applies_to_transfer", true).eq("inventory_treatment", "capitalize").order("code"),
    isFeatureEnabled(ctx.companyId, "transfer_logistics"),
    // Goods can go to any branch of the company, not only the branches this user is assigned to.
    admin.from("branches").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
  ]);
  const myBranches = ctx.user.isOwner ? ctx.branches : ctx.branches.filter((b) => ctx.user.branchIds.includes(b.id));
  // Stock on hand at each branch the user can send from: only these products can be transferred.
  const { data: bals } = myBranches.length
    ? await admin.from("stock_balances").select("branch_id, product_id, quantity").eq("company_id", ctx.companyId)
        .in("branch_id", myBranches.map((b) => b.id)).gt("quantity", 0)
    : { data: [] as { branch_id: string; product_id: string; quantity: number }[] };
  const stockByBranch: Record<string, Record<string, number>> = {};
  for (const b of bals ?? []) (stockByBranch[b.branch_id] ??= {})[b.product_id] = Number(b.quantity);
  return (
    <div>
      <PageHeader title="New Transfer"
        description="Goods, truck and driver, and the loading, transport and other charges for this move. Charges are added to the cost of the goods at the receiving branch; offloading is entered when the goods are received." />
      {!ctx.branchId || myBranches.length === 0 ? <EmptyState title="Choose a branch first" /> : (
        <NewTransferForm
          products={(products ?? []) as never}
          stockByBranch={stockByBranch}
          sourceBranches={myBranches}
          allBranches={companyBranches ?? []}
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
