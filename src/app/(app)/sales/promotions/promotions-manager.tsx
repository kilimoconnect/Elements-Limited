"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import { savePromotion, setPromotionActive } from "@/lib/sales/promotion-actions";
import { describePromotion } from "@/lib/sales/promotions";
import { formatDate, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { ProductPicker, type PickerProduct } from "@/components/common/product-picker";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export interface PromotionRow {
  id: string; name: string; product_id: string; product_label: string;
  min_quantity: number; free_quantity: number; repeat_per_multiple: boolean;
  reward_timing: "current_order" | "next_order"; starts_on: string; ends_on: string | null; is_active: boolean;
}

interface Draft {
  id?: string; name: string; productId: string; minQuantity: string; freeQuantity: string;
  repeatPerMultiple: boolean; rewardTiming: "current_order" | "next_order"; startsOn: string; endsOn: string;
}
const empty = (): Draft => ({ name: "", productId: "", minQuantity: "100", freeQuantity: "1", repeatPerMultiple: true, rewardTiming: "current_order", startsOn: todayISO(), endsOn: "" });

export function PromotionsManager({ rows, products, canManage }: { rows: PromotionRow[]; products: PickerProduct[]; canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [d, setD] = React.useState<Draft>(empty());
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  function edit(r?: PromotionRow) {
    setError(null);
    setD(r ? {
      id: r.id, name: r.name, productId: r.product_id, minQuantity: String(r.min_quantity), freeQuantity: String(r.free_quantity),
      repeatPerMultiple: r.repeat_per_multiple, rewardTiming: r.reward_timing, startsOn: r.starts_on, endsOn: r.ends_on ?? "",
    } : empty());
    setOpen(true);
  }

  async function save() {
    setError(null); setPending(true);
    const res = await savePromotion({
      id: d.id, name: d.name, productId: d.productId, minQuantity: Number(d.minQuantity), freeQuantity: Number(d.freeQuantity),
      repeatPerMultiple: d.repeatPerMultiple, rewardTiming: d.rewardTiming, startsOn: d.startsOn, endsOn: d.endsOn || null,
    });
    setPending(false);
    if (!res.ok) { setError(res.error ?? "Failed."); return; }
    toast.success(d.id ? "Promotion updated." : "Promotion created.");
    setOpen(false); router.refresh();
  }

  async function toggle(r: PromotionRow, on: boolean) {
    const res = await setPromotionActive(r.id, on);
    if (res.ok) { toast.success(on ? "Promotion switched on." : "Promotion switched off."); router.refresh(); }
    else toast.error(res.error ?? "Failed.");
  }

  const example = Number(d.minQuantity) > 0 && Number(d.freeQuantity) > 0
    ? describePromotion({ min_quantity: Number(d.minQuantity), free_quantity: Number(d.freeQuantity), repeat_per_multiple: d.repeatPerMultiple, reward_timing: d.rewardTiming })
    : "";

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Promotions</h2>
        {canManage && <Button size="sm" onClick={() => edit()}><Plus className="h-4 w-4" /> New promotion</Button>}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No promotions yet.</div>
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-sm">{r.product_label}</TableCell>
                  <TableCell className="text-sm">{describePromotion(r)}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.starts_on)} – {r.ends_on ? formatDate(r.ends_on) : "no end"}</TableCell>
                  <TableCell>{r.is_active ? <Badge variant="success">On</Badge> : <Badge variant="muted">Off</Badge>}</TableCell>
                  {canManage && (
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-3">
                        <Switch checked={r.is_active} onCheckedChange={(v) => toggle(r, v)} aria-label={r.is_active ? "Switch off" : "Switch on"} />
                        <Button size="sm" variant="outline" onClick={() => edit(r)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{d.id ? "Edit promotion" : "New promotion"}</DialogTitle>
            <DialogDescription>Customers who buy at least the minimum of the product in one order get the free quantity of the same product.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>Name</Label>
              <Input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Buy 100 bags, get 2 free" /></div>
            <div className="space-y-1.5"><Label>Product</Label>
              <ProductPicker products={products} value={d.productId} onChange={(v) => set({ productId: v })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Minimum quantity in one order</Label>
                <Input type="number" min="0" step="0.0001" value={d.minQuantity} onChange={(e) => set({ minQuantity: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Free quantity</Label>
                <Input type="number" min="0" step="0.0001" value={d.freeQuantity} onChange={(e) => set({ freeQuantity: e.target.value })} /></div>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={d.repeatPerMultiple} onCheckedChange={(v) => set({ repeatPerMultiple: v === true })} />
              <span>Repeat for every full multiple <span className="block text-xs text-muted-foreground">On: buying 2× the minimum gives 2× the free quantity. Off: free goods once per order.</span></span>
            </label>
            <div className="space-y-1.5"><Label>Free goods are given</Label>
              <Select value={d.rewardTiming} onValueChange={(v) => set({ rewardTiming: v as Draft["rewardTiming"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="current_order">In the same order</SelectItem>
                  <SelectItem value="next_order">In the customer’s next order</SelectItem>
                </SelectContent>
              </Select></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Starts</Label>
                <Input type="date" value={d.startsOn} onChange={(e) => set({ startsOn: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Ends (optional)</Label>
                <Input type="date" value={d.endsOn} onChange={(e) => set({ endsOn: e.target.value })} /></div>
            </div>
            {example && <p className="rounded-md bg-muted/50 px-3 py-2 text-sm">{example}.</p>}
            {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={pending}>{pending ? "Saving..." : "Save promotion"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
