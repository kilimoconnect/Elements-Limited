import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ImportForm } from "./import-form";

export const metadata: Metadata = { title: "Import Transfer Orders" };

export default async function ImportTransfersPage() {
  await requirePermissionPage("inventory.transfer_create");
  const ctx = await getActiveContext();
  const myBranches = ctx.user.isOwner ? ctx.branches : ctx.branches.filter((b) => ctx.user.branchIds.includes(b.id));
  return (
    <div className="space-y-4">
      <Button asChild variant="outline" size="sm"><Link href="/inventory/transfers"><ArrowLeft className="h-4 w-4" /> Back to transfers</Link></Button>
      <PageHeader title="Import Transfer Orders"
        description="Create many transfer orders at once from Excel or CSV: one row per product on a truck, each truck becomes one order. You see every truck and any problem before anything is created." />
      {myBranches.length === 0 ? <EmptyState title="You are not assigned to a branch" /> : (
        <ImportForm branches={myBranches.map((b) => ({ id: b.id, name: b.name }))} defaultBranch={myBranches.some((b) => b.id === ctx.branchId) ? ctx.branchId! : myBranches[0].id} />
      )}
    </div>
  );
}
