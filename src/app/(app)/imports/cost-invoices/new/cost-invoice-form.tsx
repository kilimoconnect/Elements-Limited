"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createAndPostCostInvoice } from "@/lib/imports/actions";
import { round2 } from "@/lib/sales/calc";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface SourceOpt { id: string; categoryId: string; status: string; shipmentId: string; supplierId: string | null; label: string; estimate: number; accrued: number; actual: number }
type Opt = { id: string; label: string };
type Cat = Opt & { capitalise: boolean; taxCodeId: string | null };
type Tax = { id: string; name: string; rate: number; recoverable: boolean };
const NONE = "__none__";
const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-costinv`);
const blankLine = () => ({ key: Math.random().toString(36).slice(2), category: "", source: NONE, description: "", net: "", tax: NONE });

export function CostInvoiceForm({ suppliers, branches, defaultBranchId, categories, taxCodes, sources, shipmentId, invoices }: {
  suppliers: Opt[]; branches: Opt[]; defaultBranchId: string; categories: Cat[]; taxCodes: Tax[]; sources: SourceOpt[];
  shipmentId: string | null; invoices: (Opt & { supplierId: string })[];
}) {
  const router = useRouter();
  const [supplierId, setSupplierId] = React.useState("");
  const [branchId, setBranchId] = React.useState(defaultBranchId);
  const [kind, setKind] = React.useState<"invoice" | "credit_note">("invoice");
  const [credited, setCredited] = React.useState("");
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [docNo, setDocNo] = React.useState("");
  const [due, setDue] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [lines, setLines] = React.useState([blankLine()]);
  const [requestId, setRequestId] = React.useState(newRequestId);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const taxMap = new Map(taxCodes.map((t) => [t.id, t]));
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const setLine = (i: number, patch: Partial<ReturnType<typeof blankLine>>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  // Invoices close open (estimated / accrued) costs; credit notes adjust costs that already have their invoice.
  const sourcesFor = (categoryId: string) => sources.filter((s) => s.categoryId === categoryId
    && (kind === "invoice" ? s.status === "estimated" || s.status === "accrued" : s.status === "invoiced")
    && (!shipmentId || s.shipmentId === shipmentId));
  const used = new Set(lines.map((l) => l.source).filter((s) => s !== NONE));
  const totals = lines.reduce((t, l) => {
    const net = round2(Number(l.net || 0)); const tc = l.tax === NONE ? null : taxMap.get(l.tax);
    const tax = tc ? round2(net * tc.rate / 100) : 0;
    return { net: t.net + net, tax: t.tax + tax };
  }, { net: 0, tax: 0 });

  async function submit() {
    setError(null); setPending(true);
    const res = await createAndPostCostInvoice({
      branchId, supplierId, documentDate: date, supplierInvoiceNumber: docNo, dueDate: due || null, kind,
      creditedInvoiceId: kind === "credit_note" ? credited || null : null, notes, requestId,
      lines: lines.map((l) => ({ cost_category_id: l.category, cost_source_id: l.source === NONE ? null : l.source, description: l.description,
        net_amount: Number(l.net || 0), tax_code_id: l.tax === NONE ? null : l.tax })),
    });
    setPending(false);
    if (res.ok) {
      toast.success(kind === "invoice" ? "Cost invoice posted." : "Credit note posted.");
      setRequestId(newRequestId());
      router.push(shipmentId ? `/imports/${shipmentId}` : "/imports/cost-invoices");
    } else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-4">
        <div className="space-y-1.5 sm:col-span-2"><Label>Service supplier *</Label>
          <Select value={supplierId} onValueChange={(v) => { setSupplierId(v); setCredited(""); }}><SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
            <SelectContent>{suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label>Branch</Label>
          <Select value={branchId} onValueChange={setBranchId}><SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label>Document</Label>
          <Select value={kind} onValueChange={(v) => { setKind(v as "invoice" | "credit_note"); setLines(lines.map((l) => ({ ...l, source: NONE }))); }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="invoice">Invoice</SelectItem><SelectItem value="credit_note">Credit note</SelectItem></SelectContent></Select></div>
        {kind === "credit_note" && (
          <div className="space-y-1.5 sm:col-span-2"><Label>Credited invoice *</Label>
            <Select value={credited} onValueChange={setCredited}><SelectTrigger><SelectValue placeholder={supplierId ? "Select invoice" : "Choose the supplier first"} /></SelectTrigger>
              <SelectContent>{invoices.filter((i) => i.supplierId === supplierId).map((i) => <SelectItem key={i.id} value={i.id}>{i.label}</SelectItem>)}</SelectContent></Select></div>
        )}
        <div className="space-y-1.5"><Label>Posting date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Supplier document no. *</Label><Input value={docNo} onChange={(e) => setDocNo(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Due date</Label><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
        <div className="space-y-1.5 sm:col-span-4"><Label>Notes</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      </CardContent></Card>

      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr>
            <th className="px-3 py-2 text-left">Category</th><th className="px-3 py-2 text-left">Shipment cost line</th><th className="px-3 py-2 text-left">Description</th>
            <th className="px-3 py-2 text-right">Net (TZS)</th><th className="px-3 py-2 text-left">Tax</th><th className="px-3 py-2 text-right">Tax amount</th><th />
          </tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const cat = catMap.get(l.category);
              const opts = l.category ? sourcesFor(l.category).filter((s) => s.id === l.source || !used.has(s.id)) : [];
              const src = sources.find((s) => s.id === l.source);
              const tc = l.tax === NONE ? null : taxMap.get(l.tax);
              const diff = src && kind === "invoice" ? round2(Number(l.net || 0) - (src.status === "accrued" ? src.accrued : src.estimate)) : null;
              return (
                <tr key={l.key} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <Select value={l.category} onValueChange={(v) => setLine(i, { category: v, source: NONE, tax: catMap.get(v)?.taxCodeId ?? NONE })}>
                      <SelectTrigger className="h-8 w-48"><SelectValue placeholder="Category" /></SelectTrigger>
                      <SelectContent>{categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent></Select>
                    {cat && <p className="mt-1 text-xs text-muted-foreground">{cat.capitalise ? "Capitalised into stock" : "Expense"}</p>}
                  </td>
                  <td className="px-3 py-2">
                    <Select value={l.source} onValueChange={(v) => {
                      const s = sources.find((x) => x.id === v);
                      setLine(i, { source: v, net: l.net || (s && kind === "invoice" ? String(s.status === "accrued" ? s.accrued : s.estimate) : l.net) });
                    }} disabled={!l.category}>
                      <SelectTrigger className="h-8 w-64"><SelectValue placeholder="Link cost" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{cat?.capitalise ? "— required for capitalised costs —" : "Not linked (period expense)"}</SelectItem>
                        {opts.map((s) => <SelectItem key={s.id} value={s.id}>{s.label} · {s.status === "invoiced" ? `invoiced ${formatMoney(s.actual)}` : s.status === "accrued" ? `accrued ${formatMoney(s.accrued)}` : `est. ${formatMoney(s.estimate)}`}</SelectItem>)}
                      </SelectContent></Select>
                    {diff !== null && diff !== 0 && <p className="mt-1 text-xs text-muted-foreground">Difference vs {src!.status === "accrued" ? "accrual" : "estimate"}: {formatMoney(diff)}</p>}
                    {src && src.supplierId && supplierId && src.supplierId !== supplierId && <p className="mt-1 text-xs text-warning">Cost was planned with another supplier.</p>}
                  </td>
                  <td className="px-3 py-2"><Input className="h-8 w-48" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                  <td className="px-3 py-2"><Input className="h-8 w-36 text-right tabular-nums" type="number" min="0" step="0.01" value={l.net} onChange={(e) => setLine(i, { net: e.target.value })} /></td>
                  <td className="px-3 py-2">
                    <Select value={l.tax} onValueChange={(v) => setLine(i, { tax: v })}><SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value={NONE}>No tax</SelectItem>{taxCodes.map((t) => <SelectItem key={t.id} value={t.id}>{t.name} ({t.rate}%{t.recoverable ? "" : ", non-recoverable"})</SelectItem>)}</SelectContent></Select>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{tc ? formatMoney(round2(Number(l.net || 0) * tc.rate / 100)) : "—"}</td>
                  <td className="px-3 py-2">{lines.length > 1 && <Button variant="ghost" size="sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="border-t border-border p-3"><Button variant="outline" size="sm" onClick={() => setLines([...lines, blankLine()])}>Add line</Button></div>
      </CardContent></Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Net <span className="font-semibold text-foreground tabular-nums">{formatMoney(round2(totals.net))}</span> · Tax {formatMoney(round2(totals.tax))} · Total <span className="font-semibold text-foreground tabular-nums">{formatMoney(round2(totals.net + totals.tax))}</span>. Recoverable VAT is kept out of stock cost.</p>
        <div className="flex items-center gap-2">
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button onClick={submit} disabled={pending || !supplierId}>{pending ? "Posting..." : kind === "invoice" ? "Post cost invoice" : "Post credit note"}</Button>
        </div>
      </div>
    </div>
  );
}
