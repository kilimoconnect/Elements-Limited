"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send, Ban, Trash2, Printer, RotateCcw, HandCoins, CheckCircle2, XCircle, Pencil, FileDown, Truck } from "lucide-react";
import { approveSale, rejectSale, submitSaleForApproval, voidSale, deleteSaleDraft } from "@/lib/sales/actions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type Confirm = null | "delete" | "void" | "reject";

export function SaleActions({
  id, status, approvalStatus, outstanding, customerId, canEdit, canSubmit, canApprove, canVoid, canDelete, canReceive, canReturn,
}: {
  id: string; status: string; approvalStatus: string; outstanding: number; customerId: string;
  canEdit: boolean; canSubmit: boolean; canApprove: boolean;
  canVoid: boolean; canDelete: boolean; canReceive: boolean; canReturn: boolean;
}) {
  const router = useRouter();
  const [confirm, setConfirm] = React.useState<Confirm>(null);
  const [pending, setPending] = React.useState(false);
  const draft = status === "draft";
  const awaiting = draft && approvalStatus === "pending";

  async function run(action: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setPending(true);
    const res = await action();
    setPending(false);
    if (res.ok) { toast.success(done); router.refresh(); } else toast.error(res.error ?? "Failed.");
  }
  async function onConfirm(reason: string) {
    const res = confirm === "delete" ? await deleteSaleDraft(id, reason)
      : confirm === "reject" ? await rejectSale(id, reason)
      : await voidSale(id, reason);
    if (!res.ok) return res.error ?? "Failed.";
    toast.success(confirm === "delete" ? "Draft deleted." : confirm === "reject" ? "Order rejected and sent back." : "Sale voided.");
    if (confirm === "delete") router.push("/sales/history"); else router.refresh();
  }

  const dialog = {
    delete: { title: "Delete this draft?", description: "The draft is permanently removed and recorded in the audit log.", label: "Delete" },
    void: { title: "Void this sale?", description: "Reversing stock and accounting entries are created. The original invoice stays visible.", label: "Void" },
    reject: { title: "Reject this sales order?", description: "The order goes back to the person who created it with your reason, so they can correct it and submit again.", label: "Reject" },
  } as const;
  const d = confirm ? dialog[confirm] : dialog.void;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {awaiting && canApprove && (
        <>
          <Button onClick={() => run(() => approveSale(id), "Order approved and sale posted.")} disabled={pending}>
            <CheckCircle2 className="h-4 w-4" /> Approve & post
          </Button>
          <Button variant="outline" onClick={() => setConfirm("reject")} disabled={pending}><XCircle className="h-4 w-4" /> Reject</Button>
        </>
      )}
      {draft && !awaiting && canEdit && (
        <Button asChild variant="outline"><Link href={`/sales/${id}/edit`}><Pencil className="h-4 w-4" /> Edit</Link></Button>
      )}
      {draft && !awaiting && (canApprove ? (
        <Button onClick={() => run(() => approveSale(id), "Sale approved and posted.")} disabled={pending}><CheckCircle2 className="h-4 w-4" /> Approve & post</Button>
      ) : canSubmit && (
        <Button onClick={() => run(() => submitSaleForApproval(id), "Sent for approval.")} disabled={pending}><Send className="h-4 w-4" /> Submit for approval</Button>
      ))}
      {draft && canDelete && (
        <Button variant="outline" onClick={() => setConfirm("delete")}><Trash2 className="h-4 w-4" /> Delete draft</Button>
      )}
      {status === "posted" && (
        <>
          <Button asChild variant="outline"><a href={`/api/sales/${id}/invoice`}><FileDown className="h-4 w-4" /> Invoice (PDF)</a></Button>
          <Button asChild variant="outline"><a href={`/api/sales/${id}/delivery-note`}><Truck className="h-4 w-4" /> Delivery note (PDF)</a></Button>
          <Button asChild variant="outline"><Link href={`/invoice/${id}`} target="_blank"><Printer className="h-4 w-4" /> Print</Link></Button>
        </>
      )}
      {status === "posted" && outstanding > 0 && canReceive && (
        <Button asChild variant="outline"><Link href={`/sales/customer-payments/new?customer=${customerId}&sale=${id}`}><HandCoins className="h-4 w-4" /> Receive payment</Link></Button>
      )}
      {status === "posted" && canReturn && (
        <Button asChild variant="outline"><Link href={`/sales/${id}/return`}><RotateCcw className="h-4 w-4" /> Return</Link></Button>
      )}
      {status === "posted" && canVoid && (
        <Button variant="outline" onClick={() => setConfirm("void")}><Ban className="h-4 w-4" /> Void</Button>
      )}

      <ConfirmDialog
        open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}
        title={d.title} description={d.description}
        confirmLabel={d.label} destructive requireReason onConfirm={onConfirm}
      />
    </div>
  );
}
