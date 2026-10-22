"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveTransferDraft, postTransfer } from "@/lib/cash/actions";
import { round2 } from "@/lib/sales/calc";
import { formatMoney, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface AccountOpt { id: string; name: string }

export function TransferForm({ accounts, branchId }: { accounts: AccountOpt[]; branchId: string | null }) {
  const router = useRouter();
  const [source, setSource] = React.useState("");
  const [dest, setDest] = React.useState("");
  const [date, setDate] = React.useState(todayISO());
  const [amount, setAmount] = React.useState("");
  const [fee, setFee] = React.useState("0");
  const [reference, setReference] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const amt = Number(amount || 0);
  const fe = Number(fee || 0);

  async function submit(post: boolean) {
    setError(null);
    if (!source || !dest) { setError("Select both accounts."); return; }
    if (source === dest) { setError("Source and destination must differ."); return; }
    if (!(amt > 0)) { setError("Enter an amount."); return; }
    setPending(true);
    const res = await saveTransferDraft({ sourceAccountId: source, destinationAccountId: dest, transferDate: date, amount: amt, fee: fe, sourceBranchId: branchId, reference, description });
    if (!res.ok || !res.id) { setError(res.error ?? "Failed."); setPending(false); return; }
    if (post) { const pr = await postTransfer(res.id); if (!pr.ok) { setError(pr.error ?? "Draft saved but posting failed."); setPending(false); return; } toast.success("Transfer posted."); }
    else toast.success("Draft saved.");
    router.push(`/cash-and-banks/transfers/${res.id}`);
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>From account *</Label>
          <Select value={source} onValueChange={setSource}><SelectTrigger><SelectValue placeholder="Source" /></SelectTrigger>
            <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label>To account *</Label>
          <Select value={dest} onValueChange={setDest}><SelectTrigger><SelectValue placeholder="Destination" /></SelectTrigger>
            <SelectContent>{accounts.filter((a) => a.id !== source).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Amount *</Label><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Transfer fee</Label><Input type="number" min="0" step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Reference</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Description</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      </CardContent></Card>

      <Card><CardContent className="p-5 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">Source decreases by</span><span className="tabular-nums font-medium">{formatMoney(round2(amt + fe))}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Destination increases by</span><span className="tabular-nums">{formatMoney(amt)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Bank/mobile charge</span><span className="tabular-nums">{formatMoney(fe)}</span></div>
      </CardContent></Card>

      {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => submit(false)} disabled={pending}>Save draft</Button>
        <Button onClick={() => submit(true)} disabled={pending}>{pending ? "Working..." : "Post transfer"}</Button>
      </div>
    </div>
  );
}
