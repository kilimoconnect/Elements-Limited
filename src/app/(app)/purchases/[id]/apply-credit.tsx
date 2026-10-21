"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { applySupplierCredit } from "@/lib/purchases/actions";
import { formatMoney, formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface CreditOpt { id: string; label: string; date: string; fc_remaining: number; remaining: number }

const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** Applies open supplier credits (same supplier and currency) to this invoice. */
export function ApplyCreditPanel({ payableId, currency, credits, maxOpen }: {
  payableId: string; currency: string; credits: CreditOpt[]; maxOpen: number;
}) {
  const router = useRouter();
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [requestIds, setRequestIds] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function apply(c: CreditOpt) {
    setError(null);
    const amount = Number(amounts[c.id] || 0);
    if (!(amount > 0)) { setError("Enter the amount to apply."); return; }
    const rid = requestIds[c.id] ?? newRequestId();
    setRequestIds({ ...requestIds, [c.id]: rid });
    setPending(c.id);
    const res = await applySupplierCredit({ creditId: c.id, payableId, amount, date, requestId: rid });
    setPending(null);
    if (res.ok) {
      toast.success("Supplier credit applied.");
      setAmounts({ ...amounts, [c.id]: "" });
      setRequestIds({ ...requestIds, [c.id]: newRequestId() });
      router.refresh();
    } else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2"><span className="text-muted-foreground">Application date</span>
        <Input type="date" className="h-8 w-40" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      {credits.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted-foreground">{c.label} · {formatDate(c.date)} · open {currency} {formatMoney(c.fc_remaining)}
            {currency !== "TZS" && <> (TZS {formatMoney(c.remaining)})</>}</span>
          <span className="flex items-center gap-2">
            <Input className="h-8 w-32 text-right tabular-nums" type="number" min="0" step="0.01" max={Math.min(c.fc_remaining, maxOpen)}
              value={amounts[c.id] ?? ""} onChange={(e) => setAmounts({ ...amounts, [c.id]: e.target.value })} />
            <Button size="sm" variant="outline" onClick={() => apply(c)} disabled={pending !== null}>{pending === c.id ? "Applying..." : "Apply"}</Button>
          </span>
        </div>
      ))}
      {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">{error}</p>}
    </div>
  );
}
