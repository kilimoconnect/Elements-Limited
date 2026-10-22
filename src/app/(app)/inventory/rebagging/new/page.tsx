import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { RebagForm } from "../rebag-form";
import { loadRebagOptions } from "../options";

export const metadata: Metadata = { title: "New Rebagging Order" };

export default async function NewRebagPage() {
  await requirePermissionPage("rebagging.create");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "rebagging"))) {
    return <div><PageHeader title="New Rebagging Order" /><EmptyState title="Rebagging is not enabled" /></div>;
  }
  const options = await loadRebagOptions(ctx);
  return (
    <div>
      <PageHeader title="New Rebagging Order" description="Saved as a draft. Issue the bulk when production starts, or complete in one step when it is done." />
      <RebagForm options={options} defaultBranchId={options.branches.some((b) => b.id === ctx.branchId) ? ctx.branchId! : options.branches[0]?.id ?? ""} />
    </div>
  );
}
