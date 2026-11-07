"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Route } from "lucide-react";
import { changeTransferRoute } from "@/lib/transfers/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Change only the destination branch; everything else on the transfer stays. */
export function ChangeRouteButton({ transferId, current, branches, dispatched }: {
  transferId: string; current: string; branches: { id: string; code: string; name: string }[]; dispatched: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [dest, setDest] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function save() {
    if (!dest) { setError("Choose the new destination branch."); return; }
    if (!reason.trim()) { setError("A reason is required."); return; }
    setPending(true); setError(null);
    const r = await changeTransferRoute(transferId, dest, reason);
    setPending(false);
    if (!r.ok) { setError(r.error ?? "Failed."); return; }
    toast.success("Route changed.");
    setOpen(false); setDest(""); setReason("");
    router.refresh();
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}><Route className="h-4 w-4" /> Change route</Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Change route</DialogTitle>
            <DialogDescription>
              Only the destination branch changes. Products, quantities, trips, truck and driver details stay as they are.
              {dispatched && " Goods already on the road become in transit to the new branch, and the delivery notes are re-issued with the new destination."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Current destination</Label>
              <p className="text-sm">{current}</p>
            </div>
            <div className="space-y-1.5">
              <Label>New destination</Label>
              <Select value={dest} onValueChange={setDest}>
                <SelectTrigger><SelectValue placeholder="Choose branch" /></SelectTrigger>
                <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Reason</Label>
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the route is changing" />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button onClick={save} disabled={pending}>{pending ? "Working..." : "Change route"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
