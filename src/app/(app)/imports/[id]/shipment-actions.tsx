"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  setShipmentStatus, recogniseOwnership, addCostSource, accrueCost, voidCostEstimate, finalizeShipment,
} from "@/lib/imports/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const today = () => new Date().toISOString().slice(0, 10);

function useRun() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setError(null); setPending(true);
    const res = await fn();
    setPending(false);
    if (res.ok) { toast.success(success); router.refresh(); } else setError(res.error ?? "Failed.");
    return res.ok;
  }
  return { pending, error, run };
}

export function StatusActions({ id, status, canEdit }: { id: string; status: string; canEdit: boolean }) {
  const { pending, error, run } = useRun();
  const [date, setDate] = React.useState(today());
  if (!canEdit) return null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      {status === "draft" && <Button variant="outline" disabled={pending} onClick={() => run(() => setShipmentStatus(id, "ready"), "Shipment confirmed.")}>Confirm (ready)</Button>}
      {(status === "draft" || status === "ready") && (
        <div className="flex items-end gap-1">
          <div className="space-y-1"><Label className="text-xs">Shipped (B/L) date</Label><Input className="h-9 w-40" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <Button variant="outline" disabled={pending} onClick={() => run(() => setShipmentStatus(id, "dispatched", date), "Marked as shipped.")}>Mark shipped</Button>
        </div>
      )}
      {(status === "draft" || status === "ready") && <Button variant="ghost" disabled={pending} onClick={() => run(() => setShipmentStatus(id, "cancelled"), "Shipment cancelled.")}>Cancel</Button>}
      {error && <p className="w-full text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function OwnershipAction({ id, currency, event, planningRate }: { id: string; currency: string; event: string; planningRate: number | null }) {
  const { pending, error, run } = useRun();
  const [date, setDate] = React.useState(today());
  const [rate, setRate] = React.useState(planningRate ? String(planningRate) : "");
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Ownership passes at <span className="font-medium">{event === "arrival" ? "arrival" : "bill of lading"}</span>. Recording it moves the goods into
        Import Goods in Transit (1157) against GR/IR (2130) — at the invoiced value, plus an explicit accrual for any part not yet invoiced.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1"><Label className="text-xs">Ownership date</Label><Input className="h-9 w-40" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        {currency !== "TZS" && (
          <div className="space-y-1"><Label className="text-xs">Accrual rate (TZS per 1 {currency})</Label>
            <Input className="h-9 w-40 text-right" type="number" min="0" step="0.000001" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
        )}
        <Button disabled={pending} onClick={() => run(() => recogniseOwnership(id, date, currency === "TZS" ? null : Number(rate || 0) || null), "Ownership recorded.")}>Record ownership</Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export interface CategoryOpt { id: string; code: string; name: string; treatment: string; basis: string; component: string | null }
export interface LineOpt { id: string; label: string }

export function AddCostForm({ shipmentId, categories, suppliers, lines, includesFreight, includesInsurance }: {
  shipmentId: string; categories: CategoryOpt[]; suppliers: { id: string; label: string }[]; lines: LineOpt[];
  includesFreight: boolean; includesInsurance: boolean;
}) {
  const { pending, error, run } = useRun();
  const [cat, setCat] = React.useState("");
  const [desc, setDesc] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [supplier, setSupplier] = React.useState("");
  const [basis, setBasis] = React.useState("default");
  const [direct, setDirect] = React.useState(lines[0]?.id ?? "");
  const usable = categories.filter((c) => !(c.component === "freight" && includesFreight) && !(c.component === "insurance" && includesInsurance));
  async function submit() {
    const ok = await run(() => addCostSource({
      shipmentId, categoryId: cat, description: desc, estimatedAmount: Number(amount || 0), supplierId: supplier || null,
      allocationBasis: basis === "default" ? null : basis, allocationTargets: basis === "direct" ? [{ id: direct }] : null,
    }), "Cost line added.");
    if (ok) { setDesc(""); setAmount(""); }
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-6">
        <Select value={cat} onValueChange={setCat}><SelectTrigger className="h-9 sm:col-span-2"><SelectValue placeholder="Cost category" /></SelectTrigger>
          <SelectContent>{usable.map((c) => <SelectItem key={c.id} value={c.id}>{c.name} {c.treatment === "expense" ? "(expensed)" : ""}</SelectItem>)}</SelectContent></Select>
        <Input className="h-9 sm:col-span-2" placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <Input className="h-9 text-right" type="number" min="0" step="0.01" placeholder="Estimate TZS" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Select value={supplier} onValueChange={setSupplier}><SelectTrigger className="h-9"><SelectValue placeholder="Supplier (optional)" /></SelectTrigger>
          <SelectContent>{suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}</SelectContent></Select>
        <Select value={basis} onValueChange={setBasis}><SelectTrigger className="h-9 sm:col-span-2"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Allocate by the category default</SelectItem>
            <SelectItem value="weight">By net weight</SelectItem><SelectItem value="value">By goods value</SelectItem>
            <SelectItem value="quantity">By quantity</SelectItem><SelectItem value="volume">By volume (all lines need m³)</SelectItem>
            <SelectItem value="direct">Directly to one line</SelectItem>
          </SelectContent></Select>
        {basis === "direct" && (
          <Select value={direct} onValueChange={setDirect}><SelectTrigger className="h-9 sm:col-span-2"><SelectValue /></SelectTrigger>
            <SelectContent>{lines.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}</SelectContent></Select>
        )}
        <Button className="h-9" disabled={pending || !cat} onClick={submit}>Add cost</Button>
      </div>
      <p className="text-xs text-muted-foreground">Estimates are for planning and post nothing. Freight / insurance are hidden when the goods price already includes them.</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function CostRowActions({ sourceId, status, estimate }: { sourceId: string; status: string; estimate: number }) {
  const { pending, error, run } = useRun();
  const [amount, setAmount] = React.useState(estimate ? String(estimate) : "");
  const [date, setDate] = React.useState(today());
  const [open, setOpen] = React.useState(false);
  if (status !== "estimated") return null;
  return (
    <div className="space-y-1">
      {!open ? (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Accrue</Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => voidCostEstimate(sourceId), "Estimate voided.")}>Void</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <Input className="h-8 w-32 text-right" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Input className="h-8 w-36" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Button size="sm" disabled={pending} onClick={() => run(() => accrueCost(sourceId, Number(amount || 0), date), "Accrual posted.")}>Post accrual</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function FinalizeButton({ id, ready }: { id: string; ready: boolean }) {
  const { pending, error, run } = useRun();
  return (
    <div className="space-y-1">
      <Button disabled={pending || !ready} onClick={() => run(() => finalizeShipment(id), "Shipment costs finalised.")}>Finalise landed cost</Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
