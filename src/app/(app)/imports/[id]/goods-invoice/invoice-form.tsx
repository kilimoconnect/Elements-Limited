"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createAndPostGoodsInvoice } from "@/lib/imports/actions";
import { round2 } from "@/lib/sales/calc";
import { formatMoney, formatDate, formatQuantity } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface InvLine { id: string; label: string; open_qty: number; unit_price: number; unit: string }
export interface TaxOpt { id: string; name: string; rate: number }
const NONE = "__none__";

export function GoodsInvoiceForm({ shipmentId, currency, lines, taxCodes, tableRates }: {
  shipmentId: string; currency: string; lines: InvLine[]; taxCodes: TaxOpt[]; tableRates: { date: string; rate: number }[];
}) {
  const router = useRouter();
  const isFc = currency !== "TZS";
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [invNo, setInvNo] = React.useState("");
  const [invDate, setInvDate] = React.useState("");
  const [due, setDue] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [source, setSource] = React.useState<"manual" | "rate_table">("manual");
  const [ref, setRef] = React.useState("");
  const [rows, setRows] = React.useState(lines.map((l) => ({ id: l.id, qty: String(l.open_qty), price: String(l.unit_price), tax: NONE })));
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const tableRate = tableRates.filter((r) => r.date <= date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const total = round2(rows.reduce((s, r) => s + Number(r.qty || 0) * Number(r.price || 0), 0));

  async function submit() {
    setError(null); setPending(true);
    const res = await createAndPostGoodsInvoice({
      shipmentId, documentDate: date, supplierInvoiceNumber: invNo, supplierInvoiceDate: invDate || null, dueDate: due || null,
      exchangeRate: isFc ? Number(rate || 0) : undefined, rateSource: isFc ? source : undefined, rateReference: isFc ? ref : undefined,
      lines: rows.map((r) => ({ shipment_line_id: r.id, quantity: Number(r.qty || 0), unit_price: Number(r.price || 0), tax_code_id: r.tax === NONE ? null : r.tax })),
    });
    setPending(false);
    if (res.ok) { toast.success("Goods invoice posted."); router.push(`/imports/${shipmentId}`); } else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-4">
        <div className="space-y-1.5"><Label>Posting date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Supplier invoice no. *</Label><Input value={invNo} onChange={(e) => setInvNo(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Supplier invoice date</Label><Input type="date" value={invDate} onChange={(e) => setInvDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Due date</Label><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
        {isFc && (<>
          <div className="space-y-1.5"><Label>Rate (TZS per 1 {currency}) *</Label>
            <Input type="number" min="0" step="0.000001" value={rate} onChange={(e) => { setRate(e.target.value); setSource("manual"); }} />
            <p className="text-xs text-muted-foreground">{tableRate ? <>Table {tableRate.rate} ({formatDate(tableRate.date)}) <button type="button" className="underline" onClick={() => { setRate(String(tableRate.rate)); setSource("rate_table"); }}>use</button></> : "No table rate"} · {source === "rate_table" ? "rate table" : "manual"}</p></div>
          <div className="space-y-1.5 sm:col-span-3"><Label>Rate reference</Label><Input value={ref} onChange={(e) => setRef(e.target.value)} /></div>
        </>)}
      </CardContent></Card>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr>
            <th className="px-3 py-2 text-left">Shipment line</th><th className="px-3 py-2 text-right">Not yet invoiced</th>
            <th className="px-3 py-2 text-right">Invoice qty</th><th className="px-3 py-2 text-right">Unit price ({currency})</th><th className="px-3 py-2 text-left">Tax</th>
            <th className="px-3 py-2 text-right">Line ({currency})</th>
          </tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id} className="border-t border-border">
                <td className="px-3 py-2">{l.label}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(l.open_qty)} {l.unit}</td>
                <td className="px-3 py-2 text-right"><Input className="h-8 w-32 text-right tabular-nums" type="number" min="0" max={l.open_qty} step="0.0001" value={rows[i].qty} onChange={(e) => setRows(rows.map((r, j) => j === i ? { ...r, qty: e.target.value } : r))} /></td>
                <td className="px-3 py-2 text-right"><Input className="h-8 w-32 text-right tabular-nums" type="number" min="0" step="0.01" value={rows[i].price} onChange={(e) => setRows(rows.map((r, j) => j === i ? { ...r, price: e.target.value } : r))} /></td>
                <td className="px-3 py-2"><Select value={rows[i].tax} onValueChange={(v) => setRows(rows.map((r, j) => j === i ? { ...r, tax: v } : r))}>
                  <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value={NONE}>No tax</SelectItem>{taxCodes.map((t) => <SelectItem key={t.id} value={t.id}>{t.name} ({t.rate}%)</SelectItem>)}</SelectContent></Select></td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(round2(Number(rows[i].qty || 0) * Number(rows[i].price || 0)))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Net {currency} <span className="font-semibold text-foreground tabular-nums">{formatMoney(total)}</span>
          {isFc && Number(rate) > 0 && <> · ≈ TZS {formatMoney(round2(total * Number(rate)))}</>}. Recoverable VAT stays out of stock cost; non-recoverable tax is part of it.</p>
        <div className="flex items-center gap-2">
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button onClick={submit} disabled={pending}>{pending ? "Posting..." : "Post goods invoice"}</Button>
        </div>
      </div>
    </div>
  );
}
