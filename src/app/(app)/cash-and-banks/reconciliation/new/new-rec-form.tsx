"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createReconciliation } from "@/lib/reconciliation/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { todayISO } from "@/lib/format";

export function NewRecForm({ accounts }: { accounts: { id: string; name: string }[] }) {
  const router = useRouter();
  const today = todayISO();
  const [acc, setAcc] = React.useState("");
  const [start, setStart] = React.useState(today);
  const [end, setEnd] = React.useState(today);
  const [opening, setOpening] = React.useState("0");
  const [closing, setClosing] = React.useState("0");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!acc) { setError("Select an account."); return; }
    setBusy(true);
    const res = await createReconciliation({ paymentAccountId: acc, statementStart: start, statementEnd: end, statementOpening: Number(opening || 0), statementClosing: Number(closing || 0) });
    setBusy(false);
    if (res.ok && res.id) { toast.success("Reconciliation created."); router.push(`/cash-and-banks/reconciliation/${res.id}`); }
    else setError(res.error ?? "Failed.");
  }

  return (
    <Card className="max-w-xl"><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2"><Label>Payment account</Label>
        <Select value={acc} onValueChange={setAcc}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
          <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-1.5"><Label>Statement start</Label><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
      <div className="space-y-1.5"><Label>Statement end</Label><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
      <div className="space-y-1.5"><Label>Opening balance</Label><Input type="number" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} /></div>
      <div className="space-y-1.5"><Label>Closing balance</Label><Input type="number" step="0.01" value={closing} onChange={(e) => setClosing(e.target.value)} /></div>
      {error && <p className="sm:col-span-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="sm:col-span-2"><Button onClick={submit} disabled={busy}>{busy ? "Creating..." : "Create reconciliation"}</Button></div>
    </CardContent></Card>
  );
}
