"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Pencil, Send, Undo2, XCircle } from "lucide-react";
import { approveSalesRequest, decideSalesRequest, submitSalesRequest } from "@/lib/sales/fulfilment-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/** Officer: edit / submit. Manager: verify each payment, then Approve Sale, Return or Reject. */
export function RequestActions({ id, status, canEdit, canSubmit, canDecide, selfPrepared, payments }: {
  id: string; status: string; canEdit: boolean; canSubmit: boolean; canDecide: boolean; selfPrepared: boolean;
  payments: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [basis, setBasis] = React.useState<Record<string, string>>({});
  const [checked, setChecked] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [confirm, setConfirm] = React.useState<null | "return" | "reject">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [idem] = React.useState(() => ({ current: crypto.randomUUID() }));

  async function submit() {
    const r = await submitSalesRequest(id);
    if (r.ok) { toast.success("Submitted for approval."); router.refresh(); } else toast.error(r.error ?? "Failed.");
  }
  async function approve() {
    setError(null);
    const r = await approveSalesRequest(id, payments.map((p) => ({ payment_id: p.id, basis: basis[p.id] ?? "" })), note, idem.current);
    if (!r.ok) { setError(r.error ?? "Approval failed."); return; }
    toast.success("Sale approved. The Sales Order is ready for fulfilment.");
    router.push(`/sales/orders/${r.id}`);
  }

  const missing = payments.some((p) => !(basis[p.id] ?? "").trim());
  if (selfPrepared) {
    return <p className="rounded-md bg-warning/15 px-3 py-2 text-sm">You prepared or submitted this request, so another authorised manager must approve it.</p>;
  }
  return (
    <>
      {(canEdit || canSubmit) && (
        <div className="flex flex-wrap gap-2">
          {canEdit && <Button asChild variant="outline"><Link href={`/sales/requests/${id}/edit`}><Pencil className="h-4 w-4" /> Edit</Link></Button>}
          {canSubmit && <Button onClick={submit}><Send className="h-4 w-4" /> {status === "returned" ? "Resubmit for approval" : "Submit for approval"}</Button>}
        </div>
      )}
      {canDecide && (
        <Card className="border-primary/40">
          <CardContent className="space-y-3 p-4 sm:p-5">
            <p className="font-medium">Review and approve</p>
            <p className="text-sm text-muted-foreground">Check each payment against the bank statement, mobile money record or cash count. Approving records the receipt once,
              commits the funds, reserves the stock and creates the approved Sales Order in one step.</p>
            {payments.map((p) => (
              <div key={p.id} className="space-y-1">
                <Label className="text-sm">{p.label}</Label>
                <Input placeholder="How you verified it, e.g. Seen on NMB online statement 07/11" value={basis[p.id] ?? ""} onChange={(e) => setBasis({ ...basis, [p.id]: e.target.value })} />
              </div>
            ))}
            <div className="space-y-1"><Label className="text-sm">Approval note (optional)</Label><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
              <span>I confirm the customer, products, prices, discounts and payment are correct and the payment has been received.</span>
            </label>
            {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={approve} disabled={!checked || missing}><CheckCircle2 className="h-4 w-4" /> Approve Sale</Button>
              <Button variant="outline" onClick={() => setConfirm("return")}><Undo2 className="h-4 w-4" /> Return for correction</Button>
              <Button variant="outline" onClick={() => setConfirm("reject")}><XCircle className="h-4 w-4" /> Reject</Button>
            </div>
          </CardContent>
        </Card>
      )}
      <ConfirmDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "return" ? "Return for correction?" : "Reject this request?"}
        description={confirm === "return" ? "The officer can correct and resubmit it." : "The request is closed. Nothing is posted."}
        confirmLabel={confirm === "return" ? "Return" : "Reject"} destructive requireReason
        onConfirm={async (reason) => {
          const r = await decideSalesRequest(id, confirm!, reason);
          if (!r.ok) return r.error ?? "Failed.";
          toast.success(confirm === "return" ? "Returned to the officer." : "Request rejected.");
          router.refresh();
        }} />
    </>
  );
}
