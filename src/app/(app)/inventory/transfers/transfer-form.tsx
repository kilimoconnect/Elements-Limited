"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { createTransferDraft, dispatchTransfer } from "@/lib/inventory/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { StockLineEditor, newLine, type ProductOption, type StockLine } from "@/components/inventory/stock-line-editor";
import { todayISO } from "@/lib/format";

export function NewTransferButton({
  products, branches, sourceBranchId, canDispatch,
}: {
  products: ProductOption[]; branches: { id: string; name: string; code: string }[];
  sourceBranchId: string; canDispatch: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [source, setSource] = React.useState(sourceBranchId);
  const [dest, setDest] = React.useState("");
  const [date, setDate] = React.useState(todayISO());
  const [reference, setReference] = React.useState("");
  const [lines, setLines] = React.useState<StockLine[]>([newLine()]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function reset() {
    setSource(sourceBranchId); setDest(""); setDate(todayISO());
    setReference(""); setLines([newLine()]); setError(null); setPending(false);
  }

  async function submit(dispatch: boolean) {
    setError(null);
    if (!dest) { setError("Choose a destination branch."); return; }
    if (dest === source) { setError("Source and destination must differ."); return; }
    const parsed = lines.filter((l) => l.product_id && l.quantity)
      .map((l) => ({ product_id: l.product_id, qty_requested: Number(l.quantity) }));
    if (parsed.length === 0) { setError("Add at least one product line."); return; }
    setPending(true);
    const res = await createTransferDraft({
      sourceBranchId: source, destinationBranchId: dest, transferDate: date, reference, lines: parsed,
    });
    if (!res.ok || !res.id) { setError(res.error ?? "Failed."); setPending(false); return; }
    if (dispatch) {
      const d = await dispatchTransfer(res.id);
      if (!d.ok) { setError(d.error ?? "Draft saved but dispatch failed."); setPending(false); router.refresh(); return; }
      toast.success("Transfer dispatched.");
    } else toast.success("Transfer draft saved.");
    setOpen(false); reset(); router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) reset(); }}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4" /> New Transfer</Button></DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Branch stock transfer</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1.5"><Label>From branch</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger><SelectValue placeholder="Source" /></SelectTrigger>
                <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.code} — {b.name}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-1.5"><Label>To branch</Label>
              <Select value={dest} onValueChange={setDest}>
                <SelectTrigger><SelectValue placeholder="Destination" /></SelectTrigger>
                <SelectContent>{branches.filter((b) => b.id !== source).map((b) => <SelectItem key={b.id} value={b.id}>{b.code} — {b.name}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-1.5"><Label>Date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          <div className="space-y-1.5"><Label>Reference</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
          <StockLineEditor products={products} lines={lines} setLines={setLines} showCost={false} qtyLabel="Qty to send" />
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => submit(false)} disabled={pending}>Save draft</Button>
            {canDispatch && <Button onClick={() => submit(true)} disabled={pending}>{pending ? "Working..." : "Save & Dispatch"}</Button>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
