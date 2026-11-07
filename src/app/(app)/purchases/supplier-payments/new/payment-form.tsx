"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { createAndPostSupplierPayment } from "@/lib/purchases/actions";
import { uploadAttachmentFile } from "@/lib/attachments/client-upload";
import { FilePickerList, tooBig, type PickedFile } from "@/components/common/file-picker-list";
import { round2 } from "@/lib/sales/calc";
import { formatMoney, formatDate, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** outstanding = TZS carrying; fc_outstanding = original-currency balance (foreign invoices). */
export interface Payable { payable_id: string; label: string; date: string; currency: string; outstanding: number; fc_outstanding: number }
export interface SupplierWithPayables { id: string; code: string; name: string; payables: Payable[] }
export interface AccountOpt { id: string; name: string }
interface Funding { key: string; payment_account_id: string; amount: string }

const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function SupplierPaymentForm({ branchId, suppliers, accounts, initialSupplierId, fxAllowed = false, currencies = [] }: {
  branchId: string; suppliers: SupplierWithPayables[]; accounts: AccountOpt[]; initialSupplierId?: string;
  fxAllowed?: boolean; currencies?: string[];
}) {
  const router = useRouter();
  const [supplierId, setSupplierId] = React.useState(initialSupplierId ?? "");
  // Start in the currency the preselected supplier is owed in (TZS first when owed both).
  const [currency, setCurrency] = React.useState(() => {
    const cs = (suppliers.find((x) => x.id === initialSupplierId)?.payables ?? []).map((p) => p.currency);
    return cs.includes("TZS") || cs.length === 0 ? "TZS" : cs.sort()[0];
  });
  const [date, setDate] = React.useState(todayISO());
  const [reference, setReference] = React.useState("");
  const [alloc, setAlloc] = React.useState<Record<string, string>>({});
  const [advance, setAdvance] = React.useState("");
  const [charges, setCharges] = React.useState("");
  const [chargesAccount, setChargesAccount] = React.useState(accounts[0]?.id ?? "");
  const [funding, setFunding] = React.useState<Funding[]>([{ key: "f1", payment_account_id: accounts[0]?.id ?? "", amount: "" }]);
  const [requestId, setRequestId] = React.useState(newRequestId);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /** What is owed to a supplier in each currency (foreign invoices in their own currency). */
  const owedBy = (x: SupplierWithPayables) => {
    const m = new Map<string, number>();
    for (const p of x.payables) m.set(p.currency, round2((m.get(p.currency) ?? 0) + Number(p.currency === "TZS" ? p.outstanding : p.fc_outstanding)));
    return [...m.entries()].sort(([a], [b]) => (a === "TZS" ? -1 : b === "TZS" ? 1 : a.localeCompare(b)));
  };
  const owedText = (x: SupplierWithPayables) => owedBy(x).map(([c, v]) => formatMoney(v, c)).join(" + ");
  const pickSupplier = (id: string) => {
    const x = suppliers.find((y) => y.id === id);
    const first = x ? owedBy(x)[0]?.[0] : undefined;
    setSupplierId(id); setAlloc({}); setAdvance(""); setCurrency(first ?? "TZS");
  };
  const isFc = currency !== "TZS";
  const supplier = suppliers.find((s) => s.id === supplierId);
  const payables = (supplier?.payables ?? []).filter((p) => p.currency === currency);
  const supplierCurrencies = Array.from(new Set(["TZS", ...(supplier?.payables ?? []).map((p) => p.currency), ...(fxAllowed ? currencies : [])]))
    .filter((c) => c === "TZS" || fxAllowed);
  const allocTotal = round2(payables.reduce((s, p) => s + Number(alloc[p.payable_id] || 0), 0));
  const fundTotal = round2(funding.reduce((s, f) => s + Number(f.amount || 0), 0));
  const adv = round2(Number(advance || 0));

  // Preview for foreign payments: actual TZS shared by foreign amount; FX =
  // share paid - carrying released (the server computes the posted figures).
  const fcTotal = round2(allocTotal + adv);
  const effRate = isFc && fcTotal > 0 ? fundTotal / fcTotal : 0;
  const preview = isFc ? payables.map((p) => {
    const fc = Number(alloc[p.payable_id] || 0);
    if (fc <= 0) return null;
    const released = fc >= p.fc_outstanding ? p.outstanding : round2(p.outstanding * fc / p.fc_outstanding);
    const paid = round2(fc * effRate);
    return { id: p.payable_id, released, paid, fx: round2(paid - released) };
  }).filter(Boolean) as { id: string; released: number; paid: number; fx: number }[] : [];
  const fxPreview = round2(preview.reduce((s, p) => s + p.fx, 0));

  const [files, setFiles] = React.useState<PickedFile<"proof_of_payment" | "other">[]>([]);

  async function submit() {
    setError(null);
    const big = tooBig(files);
    if (big) { setError(`${big.file.name} is larger than 20 MB.`); return; }
    if (!supplierId) { setError("Select a supplier."); return; }
    if (allocTotal <= 0 && adv <= 0) { setError("Allocate to at least one invoice or record an advance."); return; }
    if (fundTotal <= 0) { setError("Enter the TZS amount actually paid."); return; }
    if (!isFc && fundTotal !== round2(allocTotal + adv)) { setError("Funding must equal invoices settled plus any advance."); return; }
    const allocations = payables.map((p) => isFc
      ? { payable_id: p.payable_id, fc_amount: Number(alloc[p.payable_id] || 0) }
      : { payable_id: p.payable_id, amount: Number(alloc[p.payable_id] || 0) })
      .filter((a) => Number(isFc ? (a as { fc_amount: number }).fc_amount : (a as { amount: number }).amount) > 0);
    const fund = funding.filter((f) => f.payment_account_id && Number(f.amount) > 0).map((f) => ({ payment_account_id: f.payment_account_id, amount: Number(f.amount) }));
    setPending(true);
    const res = await createAndPostSupplierPayment({
      branchId, supplierId, documentDate: date, reference, funding: fund, allocations, currencyCode: currency,
      advanceAmount: adv, bankCharges: Number(charges || 0), bankChargesAccountId: Number(charges || 0) > 0 ? chargesAccount : null, requestId,
    });
    setPending(false);
    if (res.ok) {
      // Proof of payment and other documents go onto the posted payment.
      let failed = 0;
      for (const f of files) {
        const up = res.id ? await uploadAttachmentFile({ ownerType: "supplier_payment", ownerId: res.id, category: f.category, file: f.file }) : { ok: false, error: "no id" };
        if (!up.ok) { failed++; toast.error(`${f.file.name} did not upload: ${up.error}`); }
      }
      toast.success(files.length && !failed ? `Supplier payment recorded with ${files.length} file${files.length === 1 ? "" : "s"}.` : "Supplier payment recorded.");
      setRequestId(newRequestId());
      router.push(res.id ? `/purchases/supplier-payments/${res.id}` : "/purchases/supplier-payments");
    }
    else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-4">
        <div className="space-y-1.5"><Label>Supplier</Label>
          <Select value={supplierId} onValueChange={pickSupplier}>
            <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
            <SelectContent>{suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.code} — {s.name}{s.payables.length > 0 ? ` · owed ${owedText(s)}` : ""}</SelectItem>)}</SelectContent>
          </Select></div>
        <div className="space-y-1.5"><Label>Invoice currency</Label>
          <Select value={currency} onValueChange={(v) => { setCurrency(v); setAlloc({}); setAdvance(""); }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{supplierCurrencies.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select></div>
        <div className="space-y-1.5"><Label>Payment date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Reference</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
      </CardContent></Card>

      {supplier && (() => {
        const openNow = round2(payables.reduce((t, p) => t + Number(isFc ? p.fc_outstanding : p.outstanding), 0));
        const after = round2(Math.max(openNow - allocTotal, 0));
        return (
          <Card><CardContent className="grid grid-cols-1 gap-3 p-4 text-sm sm:grid-cols-4">
            <div><p className="text-xs text-muted-foreground">Outstanding with {supplier.name}</p>
              <p className="text-lg font-semibold tabular-nums">{formatMoney(openNow, isFc ? currency : undefined)}</p>
              <p className="text-xs text-muted-foreground">{payables.length} open {currency} {payables.length === 1 ? "invoice" : "invoices"}</p>
              {owedBy(supplier).filter(([c]) => c !== currency).map(([c, v]) => (
                <button key={c} type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => { setCurrency(c); setAlloc({}); setAdvance(""); }}>
                  Also owed {formatMoney(v, c)}: switch to {c}
                </button>
              ))}</div>
            <div><p className="text-xs text-muted-foreground">Paying now</p><p className="text-lg font-semibold tabular-nums">{formatMoney(allocTotal, isFc ? currency : undefined)}</p></div>
            <div><p className="text-xs text-muted-foreground">Outstanding after this payment</p><p className={`text-lg font-semibold tabular-nums ${after > 0 ? "text-destructive" : "text-success"}`}>{formatMoney(after, isFc ? currency : undefined)}</p></div>
            <div className="flex items-end">{payables.length > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setAlloc(Object.fromEntries(payables.map((p) => [p.payable_id, String(isFc ? p.fc_outstanding : p.outstanding)])))}>Pay all outstanding</Button>
            )}</div>
          </CardContent></Card>
        );
      })()}

      {supplier ? (payables.length === 0 ? <EmptyState title={`No open ${currency} invoices for this supplier`} description="You can still record an advance (prepayment) below." /> : (
        <Card><CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr>
              <th className="px-3 py-2 text-left">Document</th><th className="px-3 py-2 text-left">Date</th>
              {isFc && <th className="px-3 py-2 text-right">Open {currency}</th>}
              <th className="px-3 py-2 text-right">{isFc ? "TZS carrying" : "Outstanding"}</th>
              <th className="px-3 py-2 text-right">Settle{isFc ? ` (${currency})` : ""}</th>
              {isFc && <th className="px-3 py-2 text-right">FX (preview)</th>}
            </tr></thead>
            <tbody>
              {payables.map((p) => {
                const pv = preview.find((x) => x.id === p.payable_id);
                return (
                  <tr key={p.payable_id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{p.label}</td>
                    <td className="px-3 py-2">{formatDate(p.date)}</td>
                    {isFc && <td className="px-3 py-2 text-right tabular-nums">{formatMoney(p.fc_outstanding, currency)}</td>}
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(p.outstanding)}</td>
                    <td className="px-3 py-2 text-right"><Input className="h-8 w-32 text-right tabular-nums" type="number" min="0" max={isFc ? p.fc_outstanding : p.outstanding} step="0.01" value={alloc[p.payable_id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [p.payable_id]: e.target.value })} /></td>
                    {isFc && <td className={`px-3 py-2 text-right tabular-nums ${pv && pv.fx > 0 ? "text-destructive" : ""}`}>{pv ? formatMoney(pv.fx) : "—"}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent></Card>
      )) : <p className="text-sm text-muted-foreground">Select a supplier to see outstanding documents.</p>}

      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
        <div className="space-y-1.5"><Label>Advance / prepayment ({currency})</Label>
          <Input type="number" min="0" step="0.01" value={advance} onChange={(e) => setAdvance(e.target.value)} />
          <p className="text-xs text-muted-foreground">Unallocated amount held as a supplier advance; applied later when posting a {currency} invoice.</p></div>
        <div className="space-y-1.5"><Label>Bank charges (TZS)</Label>
          <Input type="number" min="0" step="0.01" value={charges} onChange={(e) => setCharges(e.target.value)} />
          <p className="text-xs text-muted-foreground">Posted to Bank and Mobile Money Charges, separately from any exchange difference.</p></div>
        <div className="space-y-1.5"><Label>Charges taken from</Label>
          <Select value={chargesAccount} onValueChange={setChargesAccount}><SelectTrigger><SelectValue placeholder="Account" /></SelectTrigger>
            <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div>
      </CardContent></Card>

      <Card><CardContent className="p-5">
        <div className="mb-2 flex items-center justify-between"><Label>TZS actually paid from</Label>
          <Button type="button" variant="outline" size="sm" onClick={() => setFunding([...funding, { key: Math.random().toString(36).slice(2), payment_account_id: "", amount: "" }])}><Plus className="h-4 w-4" /> Add</Button>
        </div>
        <div className="space-y-2">
          {funding.map((f) => (
            <div key={f.key} className="flex items-center gap-2">
              <Select value={f.payment_account_id} onValueChange={(v) => setFunding(funding.map((x) => x.key === f.key ? { ...x, payment_account_id: v } : x))}>
                <SelectTrigger className="h-8 flex-1"><SelectValue placeholder="Account" /></SelectTrigger>
                <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
              </Select>
              <Input className="h-8 w-40 text-right tabular-nums" type="number" min="0" step="0.01" value={f.amount} onChange={(e) => setFunding(funding.map((x) => x.key === f.key ? { ...x, amount: e.target.value } : x))} />
              <button type="button" onClick={() => setFunding(funding.filter((x) => x.key !== f.key))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      </CardContent></Card>

      <Card><CardContent className="p-5">
        <FilePickerList id="supplier-payment-files" label="Proof of payment and documents" value={files} onChange={setFiles}
          categories={[{ value: "proof_of_payment", label: "Proof of payment" }, { value: "other", label: "Other document" }]} />
      </CardContent></Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {isFc
            ? <>Settling <span className="font-semibold text-foreground tabular-nums">{formatMoney(fcTotal, currency)}</span> for <span className="tabular-nums">{formatMoney(fundTotal)}</span>{fcTotal > 0 && fundTotal > 0 && <> (≈ {round2(effRate)}) · FX {fxPreview > 0 ? "loss" : "gain"} preview <span className="tabular-nums">{formatMoney(Math.abs(fxPreview))}</span></>}</>
            : <>Allocated: <span className="font-semibold text-foreground tabular-nums">{formatMoney(allocTotal)}</span>{adv > 0 && <> + advance {formatMoney(adv)}</>} · Funding: <span className="tabular-nums">{formatMoney(fundTotal)}</span></>}
        </p>
        <div className="flex items-center gap-2">
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button variant="outline" onClick={() => router.push("/purchases/supplier-payments")} disabled={pending}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>{pending ? "Working..." : "Record payment"}</Button>
        </div>
      </div>
    </div>
  );
}
