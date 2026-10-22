"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createAndPostReturn } from "@/lib/sales/actions";
import { round2 } from "@/lib/sales/calc";
import { formatMoney, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export interface RLine {
  sale_line_id: string; description: string; sold: number; returned: number;
  unit_price: number; line_total: number;
}
export interface AccountOpt { id: string; name: string }

export function ReturnForm({ saleId, lines, accounts }: { saleId: string; lines: RLine[]; accounts: AccountOpt[] }) {
  const router = useRouter();
  const [date, setDate] = React.useState(todayISO());
  const [reason, setReason] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [qty, setQty] = React.useState<Record<string, string>>({});
  const [cond, setCond] = React.useState<Record<string, "saleable" | "damaged">>({});
  const [refundAccount, setRefundAccount] = React.useState("");
  const [refundAmount, setRefundAmount] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const value = lines.reduce((s, l) => {
    const q = Number(qty[l.sale_line_id] || 0);
    if (q <= 0) return s;
    const frac = q / l.sold;
    return round2(s + l.line_total * frac);
  }, 0);

  async function submit() {
    setError(null);
    if (!reason.trim()) { setError("A reason is required."); return; }
    const retLines = lines
      .map((l) => ({ sale_line_id: l.sale_line_id, quantity: Number(qty[l.sale_line_id] || 0), condition: cond[l.sale_line_id] ?? "saleable" }))
      .filter((l) => l.quantity > 0);
    if (retLines.length === 0) { setError("Enter quantities to return."); return; }
    const refunds = refundAccount && Number(refundAmount) > 0
      ? [{ payment_account_id: refundAccount, amount: Number(refundAmount) }] : [];
    setPending(true);
    const res = await createAndPostReturn({ saleId, returnDate: date, reason, notes, lines: retLines, refunds });
    setPending(false);
    if (res.ok) { toast.success("Return posted."); router.push(`/sales/${saleId}`); }
    else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Item</th>
              <th className="px-3 py-2 text-right">Sold</th>
              <th className="px-3 py-2 text-right">Returned</th>
              <th className="px-3 py-2 text-right">Return qty</th>
              <th className="px-3 py-2 text-left">Condition</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const max = round2(l.sold - l.returned);
              return (
                <tr key={l.sale_line_id} className="border-t border-border">
                  <td className="px-3 py-2">{l.description}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.sold}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.returned}</td>
                  <td className="px-3 py-2 text-right">
                    <Input className="h-8 w-24 text-right tabular-nums" type="number" min="0" max={max} step="0.0001"
                      value={qty[l.sale_line_id] ?? ""} onChange={(e) => setQty({ ...qty, [l.sale_line_id]: e.target.value })} disabled={max <= 0} />
                  </td>
                  <td className="px-3 py-2">
                    <Select value={cond[l.sale_line_id] ?? "saleable"} onValueChange={(v) => setCond({ ...cond, [l.sale_line_id]: v as "saleable" | "damaged" })}>
                      <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="saleable">Return to stock</SelectItem>
                        <SelectItem value="damaged">Damaged / non-saleable</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent></Card>

      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>Return date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Reason *</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being returned?" /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Notes</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Refund via (optional)</Label>
          <Select value={refundAccount} onValueChange={setRefundAccount}>
            <SelectTrigger><SelectValue placeholder="Reduce receivable (default)" /></SelectTrigger>
            <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
          </Select></div>
        <div className="space-y-1.5"><Label>Refund amount</Label>
          <Input type="number" min="0" step="0.01" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} placeholder="0.00" /></div>
      </CardContent></Card>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Return value: <span className="font-semibold text-foreground tabular-nums">{formatMoney(value)}</span></p>
        <div className="flex gap-2">
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button variant="outline" onClick={() => router.push(`/sales/${saleId}`)} disabled={pending}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>{pending ? "Working..." : "Post return"}</Button>
        </div>
      </div>
    </div>
  );
}
