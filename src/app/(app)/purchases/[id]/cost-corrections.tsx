"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { addPurchaseCost, accruePurchaseCost, removePurchaseCostEstimate, postPurchaseAdjustment } from "@/lib/costs/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-adj`);
const today = () => new Date().toISOString().slice(0, 10);
function useRun() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) => {
    setPending(true);
    const res = await fn();
    setPending(false);
    if (res.ok) { toast.success(msg); router.refresh(); return true; }
    toast.error(res.error ?? "Failed."); return false;
  };
  return { pending, run };
}

export function LandedCostForm({ purchaseId, categories }: { purchaseId: string; categories: { id: string; label: string; capitalise: boolean }[] }) {
  const { pending, run } = useRun();
  const [c, setC] = React.useState({ category: categories[0]?.id ?? "", description: "", amount: "", basis: "" });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={c.category} onValueChange={(v) => setC({ ...c, category: v })}><SelectTrigger className="h-8 w-56"><SelectValue placeholder="Category" /></SelectTrigger>
        <SelectContent>{categories.map((x) => <SelectItem key={x.id} value={x.id}>{x.label}{x.capitalise ? "" : " (expensed)"}</SelectItem>)}</SelectContent></Select>
      <Input className="h-8 w-44" placeholder="Description" value={c.description} onChange={(e) => setC({ ...c, description: e.target.value })} />
      <Input className="h-8 w-32 text-right" type="number" min="0" step="0.01" placeholder="TZS estimate" value={c.amount} onChange={(e) => setC({ ...c, amount: e.target.value })} />
      <Select value={c.basis || "__default__"} onValueChange={(v) => setC({ ...c, basis: v === "__default__" ? "" : v })}><SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="__default__">Category default</SelectItem><SelectItem value="weight">By net kg</SelectItem><SelectItem value="value">By value</SelectItem><SelectItem value="quantity">By units</SelectItem></SelectContent></Select>
      <Button size="sm" variant="outline" disabled={pending || !c.category} onClick={async () => {
        if (await run(() => addPurchaseCost({ purchaseId, categoryId: c.category, description: c.description, amount: Number(c.amount || 0), basis: c.basis || null }), "Cost added (estimate).")) setC({ ...c, description: "", amount: "" });
      }}>Add landed cost</Button>
    </div>
  );
}

export function LandedCostRow({ sourceId, status, estimate }: { sourceId: string; status: string; estimate: number }) {
  const { pending, run } = useRun();
  const [amount, setAmount] = React.useState(String(estimate || ""));
  const [date, setDate] = React.useState(today());
  if (status !== "estimated") return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Input className="h-7 w-28 text-right" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <Input className="h-7 w-36" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <Button size="sm" disabled={pending} onClick={() => run(() => accruePurchaseCost(sourceId, Number(amount || 0), date), "Cost accrued and applied to the goods.")}>Accrue</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => removePurchaseCostEstimate(sourceId), "Estimate removed.")}>Remove</Button>
    </span>
  );
}

export function PriceAdjustmentForm({ purchaseId, lines }: { purchaseId: string; lines: { id: string; label: string }[] }) {
  const { pending, run } = useRun();
  const [kind, setKind] = React.useState<"credit_note" | "debit_note">("credit_note");
  const [date, setDate] = React.useState(today());
  const [reference, setReference] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const [requestId, setRequestId] = React.useState(rid);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1"><Label className="text-xs">Supplier document</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as never)}><SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="credit_note">Credit note (price lower)</SelectItem><SelectItem value="debit_note">Debit note (price higher)</SelectItem></SelectContent></Select></div>
        <div className="space-y-1"><Label className="text-xs">Date</Label><Input className="h-8 w-36" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1"><Label className="text-xs">Supplier reference</Label><Input className="h-8 w-36" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        <div className="space-y-1"><Label className="text-xs">Reason *</Label><Input className="h-8 w-64" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      {lines.map((l) => (
        <div key={l.id} className="flex items-center gap-2 text-sm">
          <span className="w-72 truncate">{l.label}</span>
          <Input className="h-8 w-36 text-right" type="number" min="0" step="0.01" placeholder="TZS" value={amounts[l.id] ?? ""} onChange={(e) => setAmounts({ ...amounts, [l.id]: e.target.value })} />
        </div>
      ))}
      <Button size="sm" disabled={pending} onClick={async () => {
        const ok = await run(() => postPurchaseAdjustment({ purchaseId, kind, date, reference, reason, requestId,
          lines: lines.map((l) => ({ purchase_line_id: l.id, amount: Number(amounts[l.id] || 0) })) }), kind === "credit_note" ? "Credit note posted." : "Debit note posted.");
        if (ok) { setAmounts({}); setReason(""); setReference(""); setRequestId(rid()); }
      }}>Post {kind === "credit_note" ? "credit" : "debit"} note</Button>
      <p className="text-xs text-muted-foreground">The supplier balance changes once; the cost difference follows the goods (stock still held, cost of sales for units sold, other branches and stock in transit). A credit beyond the open balance becomes a supplier credit that can be used or refunded.</p>
    </div>
  );
}
