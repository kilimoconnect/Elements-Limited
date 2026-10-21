"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createAndPostImportReceipt } from "@/lib/imports/actions";
import { formatQuantity } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface RecvLine { id: string; label: string; transit_kg: number; bulk: boolean; batch: string | null }
const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-receipt`);

export function ReceiveForm({ shipmentId, lines, branches, defaultBranchId, needsRate, currency }: {
  shipmentId: string; lines: RecvLine[]; branches: { id: string; label: string }[]; defaultBranchId: string; needsRate: boolean; currency: string;
}) {
  const router = useRouter();
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [branchId, setBranchId] = React.useState(defaultBranchId);
  const [notes, setNotes] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [rows, setRows] = React.useState(lines.map((l) => ({
    id: l.id, kg: "", qty: "", wb: "", batch: l.batch ?? "", final: false, resolution: "" as "" | "normal_loss" | "write_off" | "claim",
  })));
  const [requestId, setRequestId] = React.useState(newRequestId);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const setRow = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function submit() {
    setError(null); setPending(true);
    const res = await createAndPostImportReceipt({
      shipmentId, branchId, receiptDate: date, notes, requestId, goodsAccrualRate: needsRate ? Number(rate || 0) || null : null,
      lines: rows.map((r, i) => ({
        shipment_line_id: r.id, net_kg: Number(r.kg || 0), quantity: lines[i].bulk ? undefined : Number(r.qty || 0),
        weighbridge_ref: r.wb, batch_code: r.batch, is_final: r.final, resolution: r.resolution || null,
      })).filter((l) => l.net_kg > 0 || l.is_final),
    });
    setPending(false);
    if (res.ok) { toast.success("Goods received into bulk stock."); setRequestId(newRequestId()); router.push(`/imports/${shipmentId}`); }
    else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
        <div className="space-y-1.5"><Label>Receipt date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Received at</Label>
          <Select value={branchId} onValueChange={setBranchId}><SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.label}</SelectItem>)}</SelectContent></Select></div>
        {needsRate && (
          <div className="space-y-1.5"><Label>Accrual rate for uninvoiced goods (TZS per 1 {currency})</Label>
            <Input type="number" min="0" step="0.000001" value={rate} onChange={(e) => setRate(e.target.value)} />
            <p className="text-xs text-muted-foreground">Ownership passes on receipt; the uninvoiced part is accrued at this rate and trued up by the invoice.</p></div>
        )}
        <div className="space-y-1.5 sm:col-span-3"><Label>Notes</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      </CardContent></Card>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr>
            <th className="px-3 py-2 text-left">Line</th><th className="px-3 py-2 text-right">In transit (kg)</th><th className="px-3 py-2 text-right">Net kg received</th>
            <th className="px-3 py-2 text-right">Units</th><th className="px-3 py-2 text-left">Weighbridge ref</th><th className="px-3 py-2 text-left">Batch</th>
            <th className="px-3 py-2 text-left">Last receipt?</th><th className="px-3 py-2 text-left">Shortfall</th>
          </tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const short = rows[i].final ? Math.max(l.transit_kg - Number(rows[i].kg || 0), 0) : 0;
              return (
                <tr key={l.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">{l.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(l.transit_kg)}</td>
                  <td className="px-3 py-2"><Input className="h-8 w-32 text-right tabular-nums" type="number" min="0" max={l.transit_kg} step="0.0001" value={rows[i].kg} onChange={(e) => setRow(i, { kg: e.target.value })} /></td>
                  <td className="px-3 py-2"><Input className="h-8 w-24 text-right tabular-nums" type="number" min="0" step="1" disabled={l.bulk} placeholder={l.bulk ? "= kg" : ""} value={rows[i].qty} onChange={(e) => setRow(i, { qty: e.target.value })} /></td>
                  <td className="px-3 py-2"><Input className="h-8 w-32" value={rows[i].wb} onChange={(e) => setRow(i, { wb: e.target.value })} /></td>
                  <td className="px-3 py-2"><Input className="h-8 w-28" value={rows[i].batch} onChange={(e) => setRow(i, { batch: e.target.value })} /></td>
                  <td className="px-3 py-2"><input type="checkbox" checked={rows[i].final} onChange={(e) => setRow(i, { final: e.target.checked })} /></td>
                  <td className="px-3 py-2">
                    {short > 0 ? (
                      <div className="space-y-1">
                        <p className="text-xs text-destructive">{formatQuantity(short)} kg short</p>
                        <Select value={rows[i].resolution} onValueChange={(v) => setRow(i, { resolution: v as "normal_loss" | "write_off" | "claim" })}>
                          <SelectTrigger className="h-8 w-44"><SelectValue placeholder="Resolution (approver)" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="normal_loss">Normal loss (absorbed)</SelectItem>
                            <SelectItem value="write_off">Write off (expense)</SelectItem>
                            <SelectItem value="claim">Claim (insurer / carrier)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent></Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Goods enter bulk stock at their share of the in-transit landed cost. Tick &quot;Last receipt&quot; to close a line; any shortfall needs an approver&apos;s resolution.</p>
        <div className="flex items-center gap-2">
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button onClick={submit} disabled={pending}>{pending ? "Posting..." : "Post receipt"}</Button>
        </div>
      </div>
    </div>
  );
}
