"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { createAndPostFinancialOpening } from "@/lib/cash/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { todayISO } from "@/lib/format";

export interface AccountOpt { id: string; name: string }
interface Line { key: string; payment_account_id: string; side: "debit" | "credit"; amount: string }
const nl = (): Line => ({ key: Math.random().toString(36).slice(2), payment_account_id: "", side: "debit", amount: "" });

export function NewOpeningButton({ accounts }: { accounts: AccountOpt[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState(todayISO());
  const [reference, setReference] = React.useState("");
  const [lines, setLines] = React.useState<Line[]>([nl()]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    const parsed = lines.filter((l) => l.payment_account_id && Number(l.amount) > 0).map((l) => ({ payment_account_id: l.payment_account_id, side: l.side, amount: Number(l.amount) }));
    if (parsed.length === 0) { setError("Add at least one line."); return; }
    setPending(true);
    const res = await createAndPostFinancialOpening({ openingDate: date, reference, lines: parsed });
    setPending(false);
    if (res.ok) { toast.success("Opening balances posted."); setOpen(false); setLines([nl()]); router.refresh(); }
    else setError(res.error ?? "Failed.");
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setLines([nl()]); setError(null); } }}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4" /> New Opening</Button></DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Financial opening balances</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5"><Label>Opening date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Reference</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
          </div>
          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.key} className="flex items-center gap-2">
                <Select value={l.payment_account_id} onValueChange={(v) => setLines(lines.map((x) => x.key === l.key ? { ...x, payment_account_id: v } : x))}>
                  <SelectTrigger className="h-8 flex-1"><SelectValue placeholder="Account" /></SelectTrigger>
                  <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={l.side} onValueChange={(v) => setLines(lines.map((x) => x.key === l.key ? { ...x, side: v as "debit" | "credit" } : x))}>
                  <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="debit">Debit (+)</SelectItem><SelectItem value="credit">Credit (−)</SelectItem></SelectContent>
                </Select>
                <Input className="h-8 w-32 text-right tabular-nums" type="number" min="0" step="0.01" value={l.amount} onChange={(e) => setLines(lines.map((x) => x.key === l.key ? { ...x, amount: e.target.value } : x))} />
                <button type="button" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, nl()])}><Plus className="h-4 w-4" /> Add line</Button>
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="flex justify-end"><Button onClick={submit} disabled={pending}>{pending ? "Working..." : "Post opening balances"}</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
