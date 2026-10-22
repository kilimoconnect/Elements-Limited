"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { issueRebagOrder, completeRebagOrder, cancelRebagOrder, voidRebagOrder, deleteDraftRebagOrder } from "@/lib/rebagging/actions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type Dialog = null | "issue" | "complete" | "cancel" | "void" | "delete";

export function OrderActions({ id, status, can }: {
  id: string; status: string; can: { edit: boolean; post: boolean; void: boolean };
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState<Dialog>(null);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string, then?: () => void) => {
    const res = await fn();
    if (!res.ok) return res.error ?? "Failed.";
    toast.success(msg); setOpen(null);
    if (then) then(); else router.refresh();
  };
  const editable = ["draft", "issued"].includes(status);
  return (
    <div className="flex flex-wrap gap-2">
      {editable && can.edit && <Button asChild variant="outline"><Link href={`/inventory/rebagging/${id}/edit`}>{status === "issued" ? "Record results" : "Edit"}</Link></Button>}
      {status === "draft" && can.post && <Button variant="outline" onClick={() => setOpen("issue")}>Issue bulk</Button>}
      {editable && can.post && <Button onClick={() => setOpen("complete")}>Complete</Button>}
      {editable && can.post && <Button variant="ghost" onClick={() => setOpen("cancel")}>Cancel order</Button>}
      {status === "draft" && can.edit && <Button variant="ghost" onClick={() => setOpen("delete")}>Delete draft</Button>}
      {status === "completed" && can.void && <Button variant="ghost" onClick={() => setOpen("void")}>Void</Button>}

      <ConfirmDialog open={open === "issue"} onOpenChange={(o) => setOpen(o ? "issue" : null)} title="Issue the bulk to production?"
        description="The bulk kg leave bulk stock at the current weighted-average cost and are held on this order until it is completed or cancelled."
        confirmLabel="Issue" onConfirm={() => run(() => issueRebagOrder(id), "Bulk issued.")} />
      <ConfirmDialog open={open === "complete"} onOpenChange={(o) => setOpen(o ? "complete" : null)} title="Complete this rebagging order?"
        description="Posts bulk and packaging consumption, the packaged output, accrued charges and any abnormal loss in one step. The kg must balance and packaging must reconcile."
        confirmLabel="Complete" onConfirm={() => run(() => completeRebagOrder(id), "Rebagging completed.")} />
      <ConfirmDialog open={open === "cancel"} onOpenChange={(o) => setOpen(o ? "cancel" : null)} title="Cancel this order?" destructive requireReason
        description={status === "issued" ? "The issued bulk goes back to bulk stock at its issue value." : "Nothing has been posted; the draft is closed."}
        confirmLabel="Cancel order" onConfirm={(r) => run(() => cancelRebagOrder(id, r), "Order cancelled.")} />
      <ConfirmDialog open={open === "void"} onOpenChange={(o) => setOpen(o ? "void" : null)} title="Void this completed order?" destructive requireReason
        description="Allowed only while none of its bags have been sold, transferred or adjusted and no charge has its supplier invoice. Bulk and packaging go back; the bags are removed."
        confirmLabel="Void" onConfirm={(r) => run(() => voidRebagOrder(id, r), "Order voided.")} />
      <ConfirmDialog open={open === "delete"} onOpenChange={(o) => setOpen(o ? "delete" : null)} title="Delete this draft?" destructive
        confirmLabel="Delete" onConfirm={() => run(() => deleteDraftRebagOrder(id), "Draft deleted.", () => router.push("/inventory/rebagging"))} />
    </div>
  );
}
