"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { createAdjustmentDraft, postAdjustment } from "@/lib/inventory/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { StockLineEditor, newLine, type ProductOption, type StockLine } from "@/components/inventory/stock-line-editor";
import { todayISO } from "@/lib/format";

const REASONS = ["Damaged goods", "Expired goods", "Theft or loss", "Physical-count difference", "Data correction", "Other"];

export function NewAdjustmentButton({ products, branchId, canPost }: { products: ProductOption[]; branchId: string; canPost: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState(todayISO());
  const [direction, setDirection] = React.useState<"increase" | "decrease">("decrease");
  const [reason, setReason] = React.useState(REASONS[0]);
  const [description, setDescription] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [lines, setLines] = React.useState<StockLine[]>([newLine()]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function reset() {
    setDate(todayISO()); setDirection("decrease"); setReason(REASONS[0]);
    setDescription(""); setReference(""); setLines([newLine()]); setError(null); setPending(false);
  }

  async function submit(post: boolean) {
    setError(null);
    const parsed = lines.filter((l) => l.product_id && l.quantity)
      .map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit_cost: Number(l.unit_cost || 0) }));
    if (parsed.length === 0) { setError("Add at least one product line."); return; }
    setPending(true);
    const res = await createAdjustmentDraft({ branchId, adjustmentDate: date, direction, reason, description, reference, lines: parsed });
    if (!res.ok || !res.id) { setError(res.error ?? "Failed."); setPending(false); return; }
    if (post) {
      const p = await postAdjustment(res.id);
      if (!p.ok) { setError(p.error ?? "Draft saved but posting failed."); setPending(false); router.refresh(); return; }
      toast.success("Adjustment posted.");
    } else toast.success("Adjustment draft saved.");
    setOpen(false); reset(); router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) reset(); }}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4" /> New Adjustment</Button></DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Stock adjustment</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1.5"><Label>Date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Direction</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as "increase" | "decrease")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="increase">Increase (+)</SelectItem>
                  <SelectItem value="decrease">Decrease (−)</SelectItem>
                </SelectContent>
              </Select></div>
            <div className="space-y-1.5"><Label>Reason</Label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
              </Select></div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Reference</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Description</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          </div>
          <StockLineEditor products={products} lines={lines} setLines={setLines} showCost={direction === "increase"}
            qtyLabel="Quantity" />
          <p className="text-xs text-muted-foreground">
            {direction === "increase" ? "Positive adjustments require a unit cost." : "Decreases use the current weighted-average cost."}
          </p>
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => submit(false)} disabled={pending}>Save draft</Button>
            {canPost && <Button onClick={() => submit(true)} disabled={pending}>{pending ? "Working..." : "Save & Post"}</Button>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
