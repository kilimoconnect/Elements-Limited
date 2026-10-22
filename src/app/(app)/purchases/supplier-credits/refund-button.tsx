"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { refundSupplierCredit } from "@/lib/costs/actions";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-refund`);

export function RefundButton({ creditId, open, accounts }: { creditId: string; open: number; accounts: { id: string; label: string }[] }) {
  const router = useRouter();
  const [show, setShow] = React.useState(false);
  const [account, setAccount] = React.useState(accounts[0]?.id ?? "");
  const [amount, setAmount] = React.useState(String(open));
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = React.useState("");
  const [requestId, setRequestId] = React.useState(rid);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setShow(true)}>Record refund</Button>
      <Dialog open={show} onOpenChange={setShow}>
        <DialogContent>
          <DialogHeader><DialogTitle>Supplier refund (open {formatMoney(open)})</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1"><Label>Received into</Label>
              <Select value={account} onValueChange={setAccount}><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>)}</SelectContent></Select></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>Amount (TZS)</Label><Input type="number" min="0" max={open} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
              <div className="space-y-1"><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            </div>
            <div className="space-y-1"><Label>Reference</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShow(false)}>Cancel</Button>
            <Button disabled={pending} onClick={async () => {
              setPending(true); setError(null);
              const res = await refundSupplierCredit({ creditId, paymentAccountId: account, amount: Number(amount || 0), date, reference, requestId });
              setPending(false);
              if (res.ok) { toast.success("Refund recorded."); setShow(false); setRequestId(rid()); router.refresh(); } else setError(res.error ?? "Failed.");
            }}>Record refund</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
