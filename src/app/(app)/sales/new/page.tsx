import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { loadRequestFormData } from "@/lib/sales/request-form-data";
import { RequestForm } from "./request-form";
import { BranchPicker } from "./branch-picker";

export const metadata: Metadata = { title: "New Sales Request" };

export default async function NewSalesRequestPage(props: { searchParams: Promise<{ branch?: string }> }) {
  await requirePermissionPage("sales.create");
  const ctx = await getActiveContext();
  const { branch } = await props.searchParams;
  // Several branches: the user chooses first (the form opens after). One branch: it opens at once.
  const chosen = branch && ctx.branches.some((b) => b.id === branch) ? branch : null;
  const branchId = ctx.branches.length > 1 ? chosen : (chosen ?? ctx.branchId);
  if (!branchId && ctx.branches.length > 1) {
    return (
      <div>
        <PageHeader title="New Sales Request" description="Choose the branch this sale is made from. The form opens once a branch is chosen." />
        <BranchPicker value="" branches={ctx.branches.map((b) => ({ id: b.id, name: b.name }))} path="/sales/new" />
      </div>
    );
  }
  if (!branchId) {
    return (
      <div>
        <PageHeader title="New Sales Request" />
        <EmptyState title="No active branch" description="You need an assigned branch to create sales requests." />
      </div>
    );
  }
  const d = await loadRequestFormData(ctx.companyId, branchId);
  return (
    <div>
      <PageHeader title="New Sales Request"
        description="Enter the customer, products and the payment received with its reference and proof. A manager verifies the payment and approves once; the order is then created and you load the trucks." />
      {ctx.branches.length > 1 && <BranchPicker value={branchId} branches={ctx.branches.map((b) => ({ id: b.id, name: b.name }))} path="/sales/new" />}
      <RequestForm key={branchId} branchId={branchId} products={d.products} taxCodes={d.taxCodes as never} accounts={d.accounts as never}
        customers={d.customers as never} onHand={d.onHand} reserved={d.reserved} funds={d.funds}
        promotions={d.promotions} rewards={d.rewards} />
    </div>
  );
}
