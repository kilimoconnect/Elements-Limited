"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FilePen, Undo2, XCircle, Banknote, HandCoins } from "lucide-react";
import {
  approveAmendment, rejectAmendment, requestAmendment, resolveException, reverseAdvance, refundAdvance, commitOrderFunds,
} from "@/lib/sales/fulfilment-actions";
import { formatMoney, formatQuantity, formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Exc { id: string; kind: string; description: string; status: string; resolution: string | null; resolved_by: string; raised_at: string; truck: string | null }
interface Amd { id: string; kind: string; reason: string; status: string; changes: Record<string, unknown>; requested_by: string; requester: string; requested_at: string; value_change: number | null; decision_reason: string | null }
interface Fund { id: string; label: string; available: number }

const KIND: Record<string, string> = {
  delivery_shortage: "Delivery shortage", delivery_damage: "Damaged on delivery", payment_reversed: "Payment reversed", other: "Exception",
  change_lines: "Change quantity / price", delivery: "Change delivery details", cancel_remaining: "Cancel the remaining balance",
  change_branch: "Change branch",
};

export function OrderActions({ orderId, open, isManager, canFulfil, userId, lines, delivery, exceptions, amendments, receipts, otherFunds, accounts, branches = [] }: {
  orderId: string; open: boolean; isManager: boolean; canFulfil: boolean; userId: string;
  lines: { id: string; description: string; quantity: number; unit_price: number; min: number; charge: boolean }[];
  delivery: { destination: string; consignee_name: string; consignee_phone: string };
  exceptions: Exc[]; amendments: Amd[]; receipts: Fund[]; otherFunds: Fund[]; accounts: { id: string; name: string }[];
  /** Other active branches the order can move to. */
  branches?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [resolve, setResolve] = React.useState<Exc | null>(null);
  const [reject, setReject] = React.useState<Amd | null>(null);
  const [reverse, setReverse] = React.useState<Fund | null>(null);
  const [amend, setAmend] = React.useState(false);
  const [approveAmd, setApproveAmd] = React.useState<Amd | null>(null);
  const [refund, setRefund] = React.useState<Fund | null>(null);
  const [commit, setCommit] = React.useState(false);
  const done = (msg: string) => { toast.success(msg); router.refresh(); };

  const openExc = exceptions.filter((x) => x.status === "open");
  return (
    <>
      {(exceptions.length > 0 || amendments.length > 0) && (
        <Card>
          <CardContent className="space-y-3 p-4 sm:p-5">
            {exceptions.length > 0 && <p className="text-sm font-medium">Exceptions</p>}
            {exceptions.map((x) => (
              <div key={x.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{x.status === "open" && <AlertTriangle className="mr-1 inline h-4 w-4 text-destructive" />}{KIND[x.kind] ?? x.kind}{x.truck && <span className="font-normal text-muted-foreground"> · {x.truck}</span>}</p>
                  <p className="text-muted-foreground">{x.description}</p>
                  {x.status === "resolved" && <p className="text-xs text-muted-foreground">Resolved by {x.resolved_by}: {x.resolution}</p>}
                </div>
                {x.status === "open" ? (isManager ? <Button size="sm" variant="outline" onClick={() => setResolve(x)}><CheckCircle2 className="h-4 w-4" /> Resolve</Button> : <Badge variant="destructive">Open</Badge>) : <Badge variant="success">Resolved</Badge>}
              </div>
            ))}
            {amendments.length > 0 && <p className="pt-1 text-sm font-medium">Amendments</p>}
            {amendments.map((a) => (
              <div key={a.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{KIND[a.kind] ?? a.kind}</p>
                  <p className="text-muted-foreground">{a.reason} · {a.requester}, {formatDateTime(a.requested_at)}</p>
                  <AmendmentSummary a={a} lines={lines} branches={branches} />
                  {a.value_change !== null && Number(a.value_change) !== 0 && <p className="text-xs">Order value change {formatMoney(a.value_change)}</p>}
                  {a.decision_reason && <p className="text-xs text-muted-foreground">Rejected: {a.decision_reason}</p>}
                </div>
                {a.status === "pending" && isManager && a.requested_by !== userId ? (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setApproveAmd(a)}><CheckCircle2 className="h-4 w-4" /> Approve</Button>
                    <Button size="sm" variant="outline" onClick={() => setReject(a)}><XCircle className="h-4 w-4" /> Reject</Button>
                  </div>
                ) : <Badge variant={a.status === "approved" ? "success" : a.status === "rejected" ? "destructive" : "warning"}>{a.status === "pending" ? "Awaiting manager" : a.status}</Badge>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {open && (canFulfil || isManager) && (
        <div className="flex flex-wrap gap-2">
          {canFulfil && <Button variant="outline" onClick={() => setAmend(true)}><FilePen className="h-4 w-4" /> Request amendment</Button>}
          {isManager && otherFunds.length > 0 && <Button variant="outline" onClick={() => setCommit(true)}><HandCoins className="h-4 w-4" /> Commit replacement funds</Button>}
          {isManager && receipts.map((r) => <Button key={r.id} variant="outline" onClick={() => setReverse(r)}><Undo2 className="h-4 w-4" /> Reverse {r.label.split(" · ")[0]}</Button>)}
        </div>
      )}
      {isManager && receipts.filter((r) => r.available > 0).map((r) => (
        <Button key={`rf-${r.id}`} variant="outline" className="mr-2" onClick={() => setRefund(r)}><Banknote className="h-4 w-4" /> Refund credit on {r.label.split(" · ")[0]} ({formatMoney(r.available)})</Button>
      ))}
      {openExc.length > 0 && !isManager && <p className="text-xs text-muted-foreground">Open exceptions are resolved by a Branch or Sales Manager; the order closes only after that.</p>}

      <ConfirmDialog open={!!resolve} onOpenChange={(o) => !o && setResolve(null)} title="Resolve exception" requireReason confirmLabel="Resolve"
        description={resolve?.kind === "payment_reversed" ? "The order must be covered by verified funds again (commit replacement funds or reduce the order first)." : "Describe the outcome (claim, credit note, replacement delivery...). Stock is not restored automatically."}
        onConfirm={async (r) => { const x = await resolveException(resolve!.id, r); if (!x.ok) return x.error; done("Exception resolved."); }} />
      <ConfirmDialog open={!!reject} onOpenChange={(o) => !o && setReject(null)} title="Reject amendment" requireReason confirmLabel="Reject" destructive
        onConfirm={async (r) => { const x = await rejectAmendment(reject!.id, r); if (!x.ok) return x.error; done("Amendment rejected."); }} />
      <ConfirmDialog open={!!reverse} onOpenChange={(o) => !o && setReverse(null)} title={`Reverse payment ${reverse?.label ?? ""}?`} requireReason confirmLabel="Reverse payment" destructive
        description="Use this when the payment turns out to be invalid (bounced, recalled). Trucks not yet dispatched are blocked, dispatched trucks are flagged and their invoices become unpaid."
        onConfirm={async (r) => { const x = await reverseAdvance(reverse!.id, r); if (!x.ok) return x.error; done("Payment reversed; the order is on hold."); }} />

      <AmendDialog key={amend ? "amend-open" : "amend"} open={amend} onOpenChange={setAmend} lines={lines} delivery={delivery} branches={branches}
        onSubmit={async (kind, changes, reason) => { const x = await requestAmendment(orderId, kind, changes, reason); if (!x.ok) return x.error; done("Amendment sent for approval."); }} />
      <FundsDialog key={approveAmd?.id ?? "amd"} open={!!approveAmd} onOpenChange={(o) => !o && setApproveAmd(null)} title="Approve amendment" funds={otherFunds}
        description="If the amendment increases the order value, select verified customer funds to cover the increase."
        onSubmit={async (f) => { const x = await approveAmendment(approveAmd!.id, f); if (!x.ok) return x.error; done("Amendment approved."); }} />
      <FundsDialog key={commit ? "commit-open" : "commit"} open={commit} onOpenChange={setCommit} title="Commit replacement funds" funds={otherFunds}
        description="Select verified customer funds to replace a reversed payment or cover the remaining order value."
        onSubmit={async (f) => { const x = await commitOrderFunds(orderId, f); if (!x.ok) return x.error; done("Funds committed."); }} />
      <RefundDialog key={refund?.id ?? "refund"} fund={refund} accounts={accounts} onOpenChange={(o) => !o && setRefund(null)}
        onSubmit={async (acc, amt, ref, reason) => { const x = await refundAdvance(refund!.id, acc, amt, ref, reason); if (!x.ok) return x.error; done("Refund recorded."); }} />
    </>
  );
}

function AmendmentSummary({ a, lines, branches }: { a: Amd; lines: { id: string; description: string; quantity: number; unit_price: number }[]; branches: { id: string; name: string }[] }) {
  if (a.kind === "change_branch") {
    const name = branches.find((b) => b.id === a.changes.branch_id)?.name ?? (a.changes.branch_name as string | undefined) ?? "another branch";
    return <p className="text-xs">To {name}{a.changes.fulfilment_location ? `, loading at ${a.changes.fulfilment_location}` : ""}</p>;
  }
  if (a.kind === "change_lines") {
    const ch = (a.changes.lines ?? []) as { order_line_id: string; quantity?: number; unit_price?: number }[];
    return <ul className="text-xs">{ch.map((c) => { const l = lines.find((x) => x.id === c.order_line_id); return <li key={c.order_line_id}>{l?.description}: {c.quantity !== undefined && `qty ${formatQuantity(c.quantity)}`} {c.unit_price !== undefined && `price ${formatMoney(c.unit_price)}`}</li>; })}</ul>;
  }
  if (a.kind === "delivery") return <p className="text-xs">{Object.entries(a.changes).filter(([, v]) => v).map(([k, v]) => `${k.replace("_", " ")}: ${v}`).join("; ")}</p>;
  return null;
}

function AmendDialog({ open, onOpenChange, lines, delivery, branches, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; lines: { id: string; description: string; quantity: number; unit_price: number; min: number; charge: boolean }[];
  delivery: { destination: string; consignee_name: string; consignee_phone: string }; branches: { id: string; name: string }[];
  onSubmit: (kind: "change_lines" | "delivery" | "cancel_remaining" | "change_branch", changes: Record<string, unknown>, reason: string) => Promise<string | void | undefined>;
}) {
  const [kind, setKind] = React.useState<"change_lines" | "delivery" | "cancel_remaining" | "change_branch">("change_lines");
  const [branch, setBranch] = React.useState("");
  const [location, setLocation] = React.useState("");
  const [q, setQ] = React.useState<Record<string, { quantity: string; unit_price: string }>>(() => Object.fromEntries(lines.map((l) => [l.id, { quantity: String(l.quantity), unit_price: String(l.unit_price) }])));
  const [d, setD] = React.useState(delivery);
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function go() {
    if (!reason.trim()) { setError("A reason is required."); return; }
    let changes: Record<string, unknown> = {};
    if (kind === "change_lines") {
      const ch = lines.map((l) => ({ order_line_id: l.id, quantity: Number(q[l.id]?.quantity), unit_price: Number(q[l.id]?.unit_price) }))
        .filter((c) => { const l = lines.find((x) => x.id === c.order_line_id)!; return c.quantity !== l.quantity || c.unit_price !== l.unit_price; });
      if (!ch.length) { setError("Change at least one quantity or price."); return; }
      const low = ch.find((c) => c.quantity < lines.find((l) => l.id === c.order_line_id)!.min);
      if (low) { setError("A quantity cannot go below what is already dispatched or on trucks."); return; }
      changes = { lines: ch };
    } else if (kind === "delivery") changes = d;
    else if (kind === "change_branch") {
      if (!branch) { setError("Choose the new branch."); return; }
      changes = { branch_id: branch, branch_name: branches.find((b) => b.id === branch)?.name, fulfilment_location: location.trim() || undefined };
    }
    setPending(true);
    const e = await onSubmit(kind, changes, reason.trim());
    setPending(false);
    if (e) setError(e); else onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>Request amendment</DialogTitle><DialogDescription>A manager (not you) must approve it before it takes effect.</DialogDescription></DialogHeader>
        <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="change_lines">Change quantity / price</SelectItem>
            <SelectItem value="delivery">Change delivery details (redirect)</SelectItem>
            <SelectItem value="cancel_remaining">Cancel the remaining balance</SelectItem>
            {branches.length > 0 && <SelectItem value="change_branch">Change branch</SelectItem>}
          </SelectContent>
        </Select>
        {kind === "change_lines" && lines.map((l) => (
          <div key={l.id} className="grid grid-cols-[1fr_90px_110px] items-center gap-2 text-sm">
            <span className="min-w-0 truncate">{l.description}<span className="block text-xs text-muted-foreground">min {formatQuantity(l.min)}</span></span>
            <Input className="h-8 text-right" type="number" min={l.min} step="0.0001" value={q[l.id]?.quantity ?? ""} onChange={(e) => setQ({ ...q, [l.id]: { ...q[l.id], quantity: e.target.value } })} />
            <Input className="h-8 text-right" type="number" min="0" step="0.01" value={q[l.id]?.unit_price ?? ""} onChange={(e) => setQ({ ...q, [l.id]: { ...q[l.id], unit_price: e.target.value } })} />
          </div>
        ))}
        {kind === "delivery" && (
          <div className="space-y-2">
            <div className="space-y-1"><Label>Destination</Label><Input value={d.destination} onChange={(e) => setD({ ...d, destination: e.target.value })} /></div>
            <div className="space-y-1"><Label>Consignee</Label><Input value={d.consignee_name} onChange={(e) => setD({ ...d, consignee_name: e.target.value })} /></div>
            <div className="space-y-1"><Label>Consignee phone</Label><Input value={d.consignee_phone} onChange={(e) => setD({ ...d, consignee_phone: e.target.value })} /></div>
          </div>
        )}
        {kind === "change_branch" && (
          <div className="space-y-2">
            <div className="space-y-1"><Label>New branch</Label>
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger><SelectValue placeholder="Choose branch" /></SelectTrigger>
                <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-1"><Label>Loading point at the new branch (optional)</Label><Input value={location} onChange={(e) => setLocation(e.target.value)} /></div>
            <p className="text-xs text-muted-foreground">What is not yet dispatched is reserved and loaded at the new branch. Trucks already dispatched stay as they are. Cancel any truck not yet dispatched first.</p>
          </div>
        )}
        {kind === "cancel_remaining" && <p className="text-sm text-muted-foreground">Cancel undispatched trucks first. The undelivered balance is removed and its funds go back to the customer’s credit.</p>}
        <div className="space-y-1"><Label>Reason</Label><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} /></div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button><Button onClick={go} disabled={pending}>Send for approval</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FundsDialog({ open, onOpenChange, title, description, funds, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; funds: Fund[];
  onSubmit: (f: { receipt_id: string; amount: number }[]) => Promise<string | void | undefined>;
}) {
  const [amt, setAmt] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  async function go() {
    setPending(true);
    const e = await onSubmit(funds.filter((f) => Number(amt[f.id] || 0) > 0).map((f) => ({ receipt_id: f.id, amount: Number(amt[f.id]) })));
    setPending(false);
    if (e) setError(e); else onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        {funds.length === 0 && <p className="text-sm text-muted-foreground">The customer has no verified funds available.</p>}
        {funds.map((f) => (
          <div key={f.id} className="flex items-center justify-between gap-2 text-sm">
            <span>{f.label} <span className="text-muted-foreground">({formatMoney(f.available)})</span></span>
            <Input className="h-8 w-32 text-right" type="number" min="0" step="0.01" value={amt[f.id] ?? ""} onChange={(e) => setAmt({ ...amt, [f.id]: e.target.value })} />
          </div>
        ))}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button><Button onClick={go} disabled={pending}>Confirm</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RefundDialog({ fund, accounts, onOpenChange, onSubmit }: {
  fund: Fund | null; accounts: { id: string; name: string }[]; onOpenChange: (o: boolean) => void;
  onSubmit: (account: string, amount: number, reference: string, reason: string) => Promise<string | void | undefined>;
}) {
  const [account, setAccount] = React.useState("");
  const [amount, setAmount] = React.useState(fund ? String(fund.available) : "");
  const [reference, setReference] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  async function go() {
    if (!account || !(Number(amount) > 0) || !reason.trim()) { setError("Choose the account, amount and reason."); return; }
    setPending(true);
    const e = await onSubmit(account, Number(amount), reference, reason);
    setPending(false);
    if (e) setError(e); else onOpenChange(false);
  }
  return (
    <Dialog open={!!fund} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Refund customer credit</DialogTitle><DialogDescription>Only the unused part of {fund?.label} can be refunded ({formatMoney(fund?.available ?? 0)}).</DialogDescription></DialogHeader>
        <div className="space-y-2">
          <Select value={account} onValueChange={setAccount}><SelectTrigger><SelectValue placeholder="Paid from" /></SelectTrigger>
            <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Input placeholder="Refund reference" value={reference} onChange={(e) => setReference(e.target.value)} />
          <Textarea placeholder="Reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button><Button onClick={go} disabled={pending}>Record refund</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
