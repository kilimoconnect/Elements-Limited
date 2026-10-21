"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createAndPostPurchaseReturn } from "@/lib/purchases/actions";
import { round2 } from "@/lib/sales/calc";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface RLine { purchase_line_id: string; description: string; bought: number; returned: number; unit_cost: number; line_total: number; fc_line_total?: number | null }
export interface AccountOpt { id: string; name: string }
type Method = "reduce_payable" | "supplier_credit" | "refund" | "mixed";

export function PurchaseReturnForm({ purchaseId, lines, accounts, currency = "TZS" }: { purchaseId: string; lines: RLine[]; accounts: AccountOpt[]; currency?: string }) {
  const isFc = currency !== "TZS";
  const router = useRouter();
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [method, setMethod] = React.useState<Method>("reduce_payable");
  const [qty, setQty] = React.useState<Record<string, string>>({});
  const [refundAccount, setRefundAccount] = React.useState("");
  const [refundAmount, setRefundAmount] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const value = lines.reduce((s, l) => { const q = Number(qty[l.purchase_line_id] || 0); if (q <= 0) return s; return round2(s + l.line_total * (q / l.bought)); }, 0);
  const fcValue = lines.reduce((s, l) => { const q = Number(qty[l.purchase_line_id] || 0); if (q <= 0 || l.fc_line_total == null) return s; return round2(s + l.fc_line_total * (q / l.bought)); }, 0);

  async function submit() {
    setError(null);
    if (!reason.trim()) { setError("A reason is required."); return; }
    const retLines = lines.map((l) => ({ purchase_line_id: l.purchase_line_id, quantity: Number(qty[l.purchase_line_id] || 0) })).filter((l) => l.quantity > 0);
    if (retLines.length === 0) { setError("Enter quantities to return."); return; }
    const settlements = (method === "refund" || method === "mixed") && refundAccount && Number(refundAmount) > 0
      ? [{ payment_account_id: refundAccount, amount: Number(refundAmount) }] : [];
    setPending(true);
    const res = await createAndPostPurchaseReturn({ purchaseId, returnDate: date, reason, notes, settlementMethod: method, lines: retLines, settlements });
    setPending(false);
    if (res.ok) { toast.success("Purchase return posted."); router.push(`/purchases/${purchaseId}`); }
    else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr>
            <th className="px-3 py-2 text-left">Item</th><th className="px-3 py-2 text-right">Bought</th>
            <th className="px-3 py-2 text-right">Returned</th><th className="px-3 py-2 text-right">Return qty</th>
          </tr></thead>
          <tbody>
            {lines.map((l) => { const max = round2(l.bought - l.returned); return (
              <tr key={l.purchase_line_id} className="border-t border-border">
                <td className="px-3 py-2">{l.description}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.bought}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.returned}</td>
                <td className="px-3 py-2 text-right"><Input className="h-8 w-24 text-right tabular-nums" type="number" min="0" max={max} step="0.0001" value={qty[l.purchase_line_id] ?? ""} onChange={(e) => setQty({ ...qty, [l.purchase_line_id]: e.target.value })} disabled={max <= 0} /></td>
              </tr>
            ); })}
          </tbody>
        </table>
      </CardContent></Card>

      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>Return date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Reason *</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Settlement</Label>
          <Select value={method} onValueChange={(v) => setMethod(v as Method)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="reduce_payable">Reduce supplier payable</SelectItem>
              <SelectItem value="supplier_credit">Create supplier credit</SelectItem>
              {!isFc && <SelectItem value="refund">Immediate refund</SelectItem>}
              {!isFc && <SelectItem value="mixed">Mixed (refund + payable)</SelectItem>}
            </SelectContent>
          </Select>
          {isFc && <p className="text-xs text-muted-foreground">{currency} purchase: goods and VAT are reversed at the original invoice rate; the {currency} balance or a {currency} credit is reduced at its carrying amount.</p>}
        </div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Notes</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        {(method === "refund" || method === "mixed") && (
          <>
            <div className="space-y-1.5"><Label>Refund to account</Label>
              <Select value={refundAccount} onValueChange={setRefundAccount}><SelectTrigger><SelectValue placeholder="Account" /></SelectTrigger>
                <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1.5"><Label>Refund amount</Label><Input type="number" min="0" step="0.01" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} /></div>
          </>
        )}
      </CardContent></Card>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Return value: {isFc && <><span className="font-semibold text-foreground tabular-nums">{currency} {formatMoney(fcValue)}</span> · </>}
          <span className={`tabular-nums ${isFc ? "" : "font-semibold text-foreground"}`}>TZS {formatMoney(value)}</span>{isFc && " at the original rate"}</p>
        <div className="flex items-center gap-2">
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button variant="outline" onClick={() => router.push(`/purchases/${purchaseId}`)} disabled={pending}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>{pending ? "Working..." : "Post return"}</Button>
        </div>
      </div>
    </div>
  );
}
