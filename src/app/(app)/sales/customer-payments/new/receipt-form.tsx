"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createAndPostReceipt } from "@/lib/sales/receipts-actions";
import { round2 } from "@/lib/sales/calc";
import { formatMoney, formatDate, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export interface Invoice { id: string; document_number: string | null; document_date: string; outstanding: number }
export interface CustomerWithInvoices { id: string; code: string; name: string; invoices: Invoice[] }
export interface AccountOpt { id: string; name: string }

export function ReceiptForm({
  branchId, customers, accounts, initialCustomerId, initialSaleId,
}: {
  branchId: string; customers: CustomerWithInvoices[]; accounts: AccountOpt[];
  initialCustomerId?: string; initialSaleId?: string;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = React.useState(initialCustomerId ?? "");
  const [accountId, setAccountId] = React.useState(accounts[0]?.id ?? "");
  const [date, setDate] = React.useState(todayISO());
  const [reference, setReference] = React.useState("");
  const [alloc, setAlloc] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const customer = customers.find((c) => c.id === customerId);

  React.useEffect(() => {
    // Prefill allocation for the invoice passed from the sale page.
    if (initialSaleId && customer) {
      const inv = customer.invoices.find((i) => i.id === initialSaleId);
      if (inv) setAlloc((a) => ({ ...a, [inv.id]: String(inv.outstanding) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const amount = round2((customer?.invoices ?? []).reduce((s, i) => s + Number(alloc[i.id] || 0), 0));

  async function submit() {
    setError(null);
    if (!customerId) { setError("Select a customer."); return; }
    if (!accountId) { setError("Select a payment account."); return; }
    if (amount <= 0) { setError("Enter at least one allocation."); return; }
    const allocations = (customer?.invoices ?? [])
      .map((i) => ({ sale_id: i.id, amount: Number(alloc[i.id] || 0) }))
      .filter((a) => a.amount > 0);
    setPending(true);
    const res = await createAndPostReceipt({
      branchId, customerId, documentDate: date, paymentAccountId: accountId,
      amount, reference, allocations,
    });
    setPending(false);
    if (res.ok) { toast.success("Payment recorded."); router.push("/sales/customer-payments"); }
    else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>Customer</Label>
          <Select value={customerId} onValueChange={(v) => { setCustomerId(v); setAlloc({}); }}>
            <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
            <SelectContent>{customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} — {c.name}</SelectItem>)}</SelectContent>
          </Select></div>
        <div className="space-y-1.5"><Label>Payment account</Label>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger><SelectValue placeholder="Account" /></SelectTrigger>
            <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
          </Select></div>
        <div className="space-y-1.5"><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Reference</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
      </CardContent></Card>

      {customer ? (
        customer.invoices.length === 0 ? (
          <EmptyState title="No outstanding invoices" description="This customer has nothing due." />
        ) : (
          <Card><CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Invoice</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-right">Outstanding</th>
                  <th className="px-3 py-2 text-right">Allocate</th>
                </tr>
              </thead>
              <tbody>
                {customer.invoices.map((i) => (
                  <tr key={i.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{i.document_number}</td>
                    <td className="px-3 py-2">{formatDate(i.document_date)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(i.outstanding)}</td>
                    <td className="px-3 py-2 text-right">
                      <Input className="h-8 w-32 text-right tabular-nums" type="number" min="0" max={i.outstanding} step="0.01"
                        value={alloc[i.id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent></Card>
        )
      ) : (
        <p className="text-sm text-muted-foreground">Select a customer to see outstanding invoices.</p>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Receipt amount: <span className="font-semibold text-foreground tabular-nums">{formatMoney(amount)}</span></p>
        <div className="flex items-center gap-2">
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button variant="outline" onClick={() => router.push("/sales/customer-payments")} disabled={pending}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>{pending ? "Working..." : "Record payment"}</Button>
        </div>
      </div>
    </div>
  );
}
