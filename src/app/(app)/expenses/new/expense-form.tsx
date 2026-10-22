"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { saveExpenseDraft, postExpense, type ExpenseDraftInput } from "@/lib/expenses/actions";
import { round2 } from "@/lib/sales/calc";
import { formatMoney, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface RefOpt { id: string; code?: string; name: string }
export interface TaxOpt { id: string; name: string; rate: number; is_inclusive: boolean }
export interface AccountOpt { id: string; name: string }
interface Payment { key: string; payment_account_id: string; amount: string }
const NONE = "__none__";

export function ExpenseForm({ branchId, categories, suppliers, taxCodes, accounts }: {
  branchId: string; categories: RefOpt[]; suppliers: RefOpt[]; taxCodes: TaxOpt[]; accounts: AccountOpt[];
}) {
  const router = useRouter();
  const [categoryId, setCategoryId] = React.useState("");
  const [supplierId, setSupplierId] = React.useState(NONE);
  const [date, setDate] = React.useState(todayISO());
  const [reference, setReference] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [taxCodeId, setTaxCodeId] = React.useState(NONE);
  const [amount, setAmount] = React.useState("");
  const [dueDate, setDueDate] = React.useState("");
  const [payments, setPayments] = React.useState<Payment[]>([]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const tc = taxCodeId !== NONE ? taxCodes.find((t) => t.id === taxCodeId) : null;
  const amt = Number(amount || 0);
  let net = amt, tax = 0, grand = amt;
  if (tc && tc.rate > 0) {
    if (tc.is_inclusive) { grand = round2(amt); net = round2(grand / (1 + tc.rate / 100)); tax = round2(grand - net); }
    else { net = round2(amt); tax = round2(net * tc.rate / 100); grand = round2(net + tax); }
  }
  const paid = round2(payments.reduce((s, p) => s + Number(p.amount || 0), 0));
  const outstanding = round2(grand - paid);

  async function submit(post: boolean) {
    setError(null);
    if (!categoryId) { setError("Select an expense category."); return; }
    if (!(amt > 0)) { setError("Enter an amount."); return; }
    if (post && outstanding > 0 && supplierId === NONE) { setError("A credit expense requires a supplier/payee."); return; }
    if (post && outstanding > 0 && !dueDate) { setError("A due date is required when there is an outstanding balance."); return; }
    const input: ExpenseDraftInput = {
      branchId, categoryId, supplierId: supplierId === NONE ? null : supplierId, documentDate: date,
      reference, description, taxCodeId: taxCodeId === NONE ? null : taxCodeId, amount: amt, dueDate: dueDate || null,
      payments: payments.filter((p) => p.payment_account_id && Number(p.amount) > 0).map((p) => ({ payment_account_id: p.payment_account_id, amount: Number(p.amount) })),
    };
    setPending(true);
    const res = await saveExpenseDraft(input);
    if (!res.ok || !res.id) { setError(res.error ?? "Failed."); setPending(false); return; }
    if (post) { const pr = await postExpense(res.id); if (!pr.ok) { setError(pr.error ?? "Draft saved but posting failed."); setPending(false); return; } toast.success("Expense posted."); }
    else toast.success("Draft saved.");
    router.push(`/expenses/${res.id}`);
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Category *</Label>
            <Select value={categoryId} onValueChange={setCategoryId}><SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
              <SelectContent>{categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} — {c.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label>Supplier / payee</Label>
            <Select value={supplierId} onValueChange={setSupplierId}><SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>— None —</SelectItem>{suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.code} — {s.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Reference</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Amount *</Label><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Tax</Label>
            <Select value={taxCodeId} onValueChange={setTaxCodeId}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>No tax</SelectItem>{taxCodes.map((t) => <SelectItem key={t.id} value={t.id}>{t.name} ({t.rate}%)</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Description</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Due date {outstanding > 0 && <span className="text-destructive">*</span>}</Label><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
        </CardContent></Card>

        <Card><CardContent className="p-5">
          <div className="mb-2 flex items-center justify-between"><Label>Payments</Label>
            <Button type="button" variant="outline" size="sm" onClick={() => setPayments([...payments, { key: Math.random().toString(36).slice(2), payment_account_id: "", amount: "" }])}><Plus className="h-4 w-4" /> Add payment</Button>
          </div>
          {payments.length === 0 && <p className="text-sm text-muted-foreground">No payments — this will be a credit expense.</p>}
          <div className="space-y-2">
            {payments.map((p) => (
              <div key={p.key} className="flex items-center gap-2">
                <Select value={p.payment_account_id} onValueChange={(v) => setPayments(payments.map((x) => x.key === p.key ? { ...x, payment_account_id: v } : x))}><SelectTrigger className="h-8 flex-1"><SelectValue placeholder="Account" /></SelectTrigger>
                  <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select>
                <Input className="h-8 w-32 text-right tabular-nums" type="number" min="0" step="0.01" value={p.amount} onChange={(e) => setPayments(payments.map((x) => x.key === p.key ? { ...x, amount: e.target.value } : x))} />
                <button type="button" onClick={() => setPayments(payments.filter((x) => x.key !== p.key))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        </CardContent></Card>
      </div>

      <div><Card className="sticky top-20"><CardContent className="space-y-2 p-5 text-sm">
        <Row label="Net" value={formatMoney(net)} /><Row label="Tax" value={formatMoney(tax)} />
        <div className="my-1 border-t border-border" />
        <Row label="Total" value={formatMoney(grand)} bold /><Row label="Paid" value={formatMoney(paid)} /><Row label="Outstanding" value={formatMoney(outstanding)} bold />
        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <div className="flex flex-col gap-2 pt-2">
          <Button onClick={() => submit(true)} disabled={pending}>{pending ? "Working..." : "Post expense"}</Button>
          <Button variant="outline" onClick={() => submit(false)} disabled={pending}>Save draft</Button>
        </div>
      </CardContent></Card></div>
    </div>
  );
}
function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return <div className="flex items-center justify-between"><span className={bold ? "font-medium" : "text-muted-foreground"}>{label}</span><span className={`tabular-nums ${bold ? "font-semibold" : ""}`}>{value}</span></div>;
}
