"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { createAndPostGeneralOpening, createAndPostCustomerOpening, createAndPostSupplierOpening } from "@/lib/accounting/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { todayISO } from "@/lib/format";

export interface Opt { id: string; code?: string; name: string }
interface GLine { key: string; account_id: string; debit: string; credit: string }

export function OpeningTabs({ accounts, customers, suppliers, branchId }: { accounts: Opt[]; customers: Opt[]; suppliers: Opt[]; branchId: string }) {
  const router = useRouter();
  const today = todayISO();
  const [busy, setBusy] = React.useState(false);

  // general
  const [gLines, setGLines] = React.useState<GLine[]>([{ key: "a", account_id: "", debit: "", credit: "" }, { key: "b", account_id: "", debit: "", credit: "" }]);
  const [gDate, setGDate] = React.useState(today);
  const [gRef, setGRef] = React.useState("");
  // customer
  const [cCust, setCCust] = React.useState(""); const [cAmt, setCAmt] = React.useState(""); const [cDate, setCDate] = React.useState(today); const [cDue, setCDue] = React.useState(""); const [cRef, setCRef] = React.useState("");
  // supplier
  const [sSup, setSSup] = React.useState(""); const [sAmt, setSAmt] = React.useState(""); const [sDate, setSDate] = React.useState(today); const [sDue, setSDue] = React.useState(""); const [sRef, setSRef] = React.useState("");

  async function saveGeneral() {
    setBusy(true);
    const res = await createAndPostGeneralOpening({ openingDate: gDate, reference: gRef, lines: gLines.filter((l) => l.account_id && (Number(l.debit) > 0 || Number(l.credit) > 0)).map((l) => ({ account_id: l.account_id, debit: Number(l.debit || 0), credit: Number(l.credit || 0) })) });
    setBusy(false);
    if (res.ok) { toast.success("General opening posted."); router.refresh(); } else toast.error(res.error ?? "Failed.");
  }
  async function saveCustomer() {
    setBusy(true);
    const res = await createAndPostCustomerOpening({ branchId, customerId: cCust, reference: cRef, invoiceDate: cDate, dueDate: cDue || null, amount: Number(cAmt || 0) });
    setBusy(false);
    if (res.ok) { toast.success("Customer opening posted."); setCAmt(""); router.refresh(); } else toast.error(res.error ?? "Failed.");
  }
  async function saveSupplier() {
    setBusy(true);
    const res = await createAndPostSupplierOpening({ branchId, supplierId: sSup, reference: sRef, documentDate: sDate, dueDate: sDue || null, amount: Number(sAmt || 0) });
    setBusy(false);
    if (res.ok) { toast.success("Supplier opening posted."); setSAmt(""); router.refresh(); } else toast.error(res.error ?? "Failed.");
  }

  return (
    <Tabs defaultValue="general">
      <TabsList>
        <TabsTrigger value="general">General ledger</TabsTrigger>
        <TabsTrigger value="customer">Customer</TabsTrigger>
        <TabsTrigger value="supplier">Supplier</TabsTrigger>
      </TabsList>

      <TabsContent value="general">
        <Card><CardContent className="space-y-3 p-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5"><Label>Opening date</Label><Input type="date" value={gDate} onChange={(e) => setGDate(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Reference</Label><Input value={gRef} onChange={(e) => setGRef(e.target.value)} /></div>
          </div>
          <p className="text-xs text-muted-foreground">Cannot post directly to control accounts (Cash, Bank, Mobile, A/R, A/P, Inventory, VAT). Use the subledger opening workflows for those.</p>
          {gLines.map((l) => (
            <div key={l.key} className="flex items-center gap-2">
              <Select value={l.account_id} onValueChange={(v) => setGLines(gLines.map((x) => x.key === l.key ? { ...x, account_id: v } : x))}>
                <SelectTrigger className="h-8 flex-1"><SelectValue placeholder="Account" /></SelectTrigger>
                <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>)}</SelectContent>
              </Select>
              <Input className="h-8 w-28 text-right tabular-nums" type="number" min="0" step="0.01" placeholder="Debit" value={l.debit} onChange={(e) => setGLines(gLines.map((x) => x.key === l.key ? { ...x, debit: e.target.value, credit: "" } : x))} />
              <Input className="h-8 w-28 text-right tabular-nums" type="number" min="0" step="0.01" placeholder="Credit" value={l.credit} onChange={(e) => setGLines(gLines.map((x) => x.key === l.key ? { ...x, credit: e.target.value, debit: "" } : x))} />
              <button type="button" onClick={() => setGLines(gLines.filter((x) => x.key !== l.key))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          <div className="flex justify-between">
            <Button type="button" variant="outline" size="sm" onClick={() => setGLines([...gLines, { key: Math.random().toString(36).slice(2), account_id: "", debit: "", credit: "" }])}><Plus className="h-4 w-4" /> Add line</Button>
            <Button onClick={saveGeneral} disabled={busy}>Post general opening</Button>
          </div>
        </CardContent></Card>
      </TabsContent>

      <TabsContent value="customer">
        <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Customer</Label><Select value={cCust} onValueChange={setCCust}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} — {c.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label>Amount owing</Label><Input type="number" min="0" step="0.01" value={cAmt} onChange={(e) => setCAmt(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Invoice date</Label><Input type="date" value={cDate} onChange={(e) => setCDate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Due date</Label><Input type="date" value={cDue} onChange={(e) => setCDue(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Reference</Label><Input value={cRef} onChange={(e) => setCRef(e.target.value)} /></div>
          <div className="flex items-end"><Button onClick={saveCustomer} disabled={busy || !cCust}>Post customer opening</Button></div>
        </CardContent></Card>
      </TabsContent>

      <TabsContent value="supplier">
        <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Supplier</Label><Select value={sSup} onValueChange={setSSup}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{suppliers.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} — {c.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label>Amount owed</Label><Input type="number" min="0" step="0.01" value={sAmt} onChange={(e) => setSAmt(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Document date</Label><Input type="date" value={sDate} onChange={(e) => setSDate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Due date</Label><Input type="date" value={sDue} onChange={(e) => setSDue(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Reference</Label><Input value={sRef} onChange={(e) => setSRef(e.target.value)} /></div>
          <div className="flex items-end"><Button onClick={saveSupplier} disabled={busy || !sSup}>Post supplier opening</Button></div>
        </CardContent></Card>
      </TabsContent>
    </Tabs>
  );
}
