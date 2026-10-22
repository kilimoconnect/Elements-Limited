"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send, PackageCheck, Ban } from "lucide-react";
import { dispatchTransfer, receiveTransfer, voidTransfer } from "@/lib/inventory/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export interface TLine { id: string; sku: string; name: string; qty_dispatched: number; qty_received: number }

export function TransferActions({
  id, status, lines, canDispatch, canReceive, canVoid,
}: {
  id: string; status: string; lines: TLine[];
  canDispatch: boolean; canReceive: boolean; canVoid: boolean;
}) {
  const router = useRouter();
  const [receiveOpen, setReceiveOpen] = React.useState(false);
  const [voidOpen, setVoidOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [requestId, setRequestId] = React.useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-recv`));
  const [qty, setQty] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, String(Math.max(l.qty_dispatched - l.qty_received, 0))])));

  async function doDispatch() {
    setPending(true);
    const res = await dispatchTransfer(id);
    setPending(false);
    if (res.ok) { toast.success("Dispatched."); router.refresh(); } else toast.error(res.error ?? "Failed.");
  }

  async function doReceive() {
    const payload = lines
      .map((l) => ({ line_id: l.id, qty: Number(qty[l.id] || 0) }))
      .filter((x) => x.qty > 0);
    if (payload.length === 0) { toast.error("Enter quantities to receive."); return; }
    setPending(true);
    const res = await receiveTransfer(id, payload, requestId);
    setPending(false);
    if (res.ok) { toast.success("Received."); setReceiveOpen(false); setRequestId(crypto.randomUUID()); router.refresh(); } else toast.error(res.error ?? "Failed.");
  }

  async function onVoid(reason: string) {
    const res = await voidTransfer(id, reason);
    if (!res.ok) return res.error ?? "Failed.";
    toast.success("Transfer voided."); router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      {status === "draft" && canDispatch && (
        <Button onClick={doDispatch} disabled={pending}><Send className="h-4 w-4" /> Dispatch</Button>
      )}
      {(status === "dispatched" || status === "partially_received") && canReceive && (
        <Button onClick={() => setReceiveOpen(true)}><PackageCheck className="h-4 w-4" /> Receive</Button>
      )}
      {status !== "draft" && status !== "voided" && canVoid && (
        <Button variant="outline" onClick={() => setVoidOpen(true)}><Ban className="h-4 w-4" /> Void</Button>
      )}

      <Dialog open={receiveOpen} onOpenChange={setReceiveOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Receive stock</DialogTitle></DialogHeader>
          <div className="space-y-2">
            {lines.map((l) => {
              const outstanding = l.qty_dispatched - l.qty_received;
              return (
                <div key={l.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{l.sku} — {l.name}</p>
                    <p className="text-xs text-muted-foreground">Outstanding: {outstanding}</p>
                  </div>
                  <Input className="h-8 w-28 text-right tabular-nums" type="number" min="0" max={outstanding}
                    value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} disabled={outstanding <= 0} />
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiveOpen(false)} disabled={pending}>Cancel</Button>
            <Button onClick={doReceive} disabled={pending}>{pending ? "Working..." : "Confirm receipt"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={voidOpen} onOpenChange={setVoidOpen}
        title="Void this transfer?"
        description="Dispatched and received stock will be reversed to their original branches."
        confirmLabel="Void" destructive requireReason onConfirm={onVoid}
      />
    </div>
  );
}
