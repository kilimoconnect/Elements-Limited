"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  dispatchTrip, deleteDraftTrip, voidTrip, changeTripTransport, issueDeliveryNote, addAgent, addTransferUpdate,
  resolveDiscrepancy, addTransferCharge, accrueTransferCharge, voidTransferChargeEstimate,
} from "@/lib/transfers/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { todayISO } from "@/lib/format";

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-req`);
function useRun() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) => {
    setPending(true);
    const res = await fn();
    setPending(false);
    if (res.ok) { toast.success(msg); router.refresh(); return null; }
    toast.error(res.error ?? "Failed."); return res.error ?? "Failed.";
  };
  return { pending, run };
}

export function TripActions({ transferId, tripId, status, isSender, isReceiver, canVoid, transport, canLicence }: {
  transferId: string; tripId: string; status: string; isSender: boolean; isReceiver: boolean; canVoid: boolean; canLicence: boolean;
  transport: Record<string, string>;
}) {
  const { pending, run } = useRun();
  const [open, setOpen] = React.useState<null | "dispatch" | "delete" | "void" | "change">(null);
  const [form, setForm] = React.useState(transport);
  const [reason, setReason] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  async function issueAndOpen() {
    const res = await issueDeliveryNote(tripId);
    if (!res.ok || !res.id) { toast.error(res.error ?? "Failed."); return; }
    window.open(`/api/transfers/delivery-notes/${res.id}`, "_blank", "noopener");
  }
  const fields: [string, string][] = [["driver_name", "Driver name"], ["driver_phone", "Driver phone"], ...(canLicence ? [["driver_licence", "Licence no."] as [string, string]] : []),
    ["vehicle_registration", "Truck reg."], ["trailer_registration", "Trailer reg."], ["transporter_name", "Transporter"], ["transporter_contact", "Transporter contact"]];
  return (
    <div className="flex flex-wrap gap-1.5">
      {status === "draft" && isSender && <Button size="sm" onClick={() => setOpen("dispatch")} disabled={pending}>Dispatch trip</Button>}
      {status === "draft" && isSender && <Button size="sm" variant="ghost" onClick={() => setOpen("delete")}>Delete draft</Button>}
      {["dispatched", "arrived"].includes(status) && isReceiver && <Button size="sm" asChild><Link href={`/inventory/transfers/${transferId}/trips/${tripId}/receive`}>Record arrival / receive</Link></Button>}
      {status !== "voided" && <Button size="sm" variant="outline" onClick={issueAndOpen}>Delivery note (PDF)</Button>}
      {["dispatched", "arrived"].includes(status) && (isSender || isReceiver) && <Button size="sm" variant="outline" onClick={() => { setForm(transport); setReason(""); setErr(null); setOpen("change"); }}>Change driver / vehicle</Button>}
      {status === "dispatched" && canVoid && <Button size="sm" variant="ghost" onClick={() => setOpen("void")}>Void trip</Button>}

      <ConfirmDialog open={open === "dispatch"} onOpenChange={(o) => setOpen(o ? "dispatch" : null)} title="Dispatch this trip?"
        description="The cargo leaves the sending branch's stock at its weighted-average cost and is held in stock in transit until the receiving branch records it. Quantities are locked once dispatched."
        confirmLabel="Dispatch" onConfirm={() => run(() => dispatchTrip(tripId), "Trip dispatched.").then((e) => e ?? undefined)} />
      <ConfirmDialog open={open === "delete"} onOpenChange={(o) => setOpen(o ? "delete" : null)} title="Delete this draft trip?" destructive confirmLabel="Delete"
        onConfirm={() => run(() => deleteDraftTrip(tripId), "Draft trip deleted.").then((e) => e ?? undefined)} />
      <ConfirmDialog open={open === "void"} onOpenChange={(o) => setOpen(o ? "void" : null)} title="Void this trip?" destructive requireReason confirmLabel="Void trip"
        description="Only while nothing has been received from it and no charge has been applied. The exact dispatched value returns to the sending branch."
        onConfirm={(r) => run(() => voidTrip(tripId, r), "Trip voided.").then((e) => e ?? undefined)} />
      <Dialog open={open === "change"} onOpenChange={(o) => setOpen(o ? "change" : null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Change driver / vehicle</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {fields.map(([k, l]) => (
              <div key={k} className="space-y-1"><Label>{l}</Label><Input value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></div>
            ))}
            <div className="col-span-2 space-y-1"><Label>Reason *</Label><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          </div>
          <p className="text-xs text-muted-foreground">The previous details are kept in the trip history.</p>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)}>Cancel</Button>
            <Button disabled={pending} onClick={async () => {
              const changes = Object.fromEntries(Object.entries(form).filter(([k, v]) => (transport[k] ?? "") !== (v ?? "")));
              const e = await run(() => changeTripTransport(tripId, changes, reason), "Transport details updated.");
              if (e) setErr(e); else setOpen(null);
            }}>Save change</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ResolveButton({ receiptLineId, kind, open, canResolve, canFound }: {
  receiptLineId: string; kind: "quarantine" | "short"; open: number; canResolve: boolean; canFound: boolean;
}) {
  const { pending, run } = useRun();
  const [show, setShow] = React.useState(false);
  const opts = kind === "quarantine"
    ? [["release", "Release into stock"], ["normal_loss", "Normal loss (within tolerance)"], ["write_off", "Write off (expense)"], ["claim", "Claim (carrier / insurer)"]]
    : [["found", "Arrived late (into stock)"], ["normal_loss", "Normal loss (within tolerance)"], ["write_off", "Write off (expense)"], ["claim", "Claim (carrier / insurer)"]];
  const allowed = opts.filter(([v]) => (v === "found" ? canFound : canResolve));
  const [res, setRes] = React.useState(allowed[0]?.[0] ?? "");
  const [qty, setQty] = React.useState(String(open));
  const [notes, setNotes] = React.useState("");
  const [requestId, setRequestId] = React.useState(rid);
  if (allowed.length === 0 || open <= 0) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setShow(true)}>Resolve</Button>
      <Dialog open={show} onOpenChange={setShow}>
        <DialogContent>
          <DialogHeader><DialogTitle>Resolve {kind === "quarantine" ? "quarantined" : "short"} cargo</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Select value={res} onValueChange={setRes}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{allowed.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent></Select>
            <div className="space-y-1"><Label>Quantity (open {open})</Label><Input type="number" min="0" max={open} step="0.0001" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
            <div className="space-y-1"><Label>Notes</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            <p className="text-xs text-muted-foreground">Abnormal losses are never spread over the accepted goods: they are written off or claimed.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShow(false)}>Cancel</Button>
            <Button disabled={pending} onClick={async () => {
              const e = await run(() => resolveDiscrepancy({ receiptLineId, kind, resolution: res as never, qty: Number(qty || 0), notes, requestId }), "Resolved.");
              if (!e) { setShow(false); setRequestId(rid()); }
            }}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AddAgentForm({ transferId }: { transferId: string }) {
  const { pending, run } = useRun();
  const [a, setA] = React.useState({ name: "", company: "", phone: "", role: "" });
  return (
    <div className="flex flex-wrap items-end gap-2">
      {(["name", "company", "phone", "role"] as const).map((k) => (
        <Input key={k} className="h-8 w-36" placeholder={k === "role" ? "Role (e.g. clearing)" : k[0].toUpperCase() + k.slice(1)} value={a[k]} onChange={(e) => setA({ ...a, [k]: e.target.value })} />
      ))}
      <Button size="sm" variant="outline" disabled={pending || !a.name.trim()} onClick={async () => {
        if (!(await run(() => addAgent(transferId, a), "Agent added."))) setA({ name: "", company: "", phone: "", role: "" });
      }}>Add agent</Button>
    </div>
  );
}

export function AddUpdateForm({ transferId, trips }: { transferId: string; trips: { id: string; label: string }[] }) {
  const { pending, run } = useRun();
  const [note, setNote] = React.useState("");
  const [trip, setTrip] = React.useState("__all__");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={trip} onValueChange={setTrip}><SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="__all__">Whole transfer</SelectItem>{trips.map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}</SelectContent></Select>
      <Input className="h-8 min-w-64 flex-1" placeholder="Update, e.g. passed Dodoma weighbridge, ETA 16:00" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button size="sm" variant="outline" disabled={pending || !note.trim()} onClick={async () => {
        if (!(await run(() => addTransferUpdate(transferId, trip === "__all__" ? null : trip, note), "Update added."))) setNote("");
      }}>Post update</Button>
    </div>
  );
}

export function ChargeForm({ transferId, trips, categories }: {
  transferId: string; trips: { id: string; label: string }[]; categories: { id: string; label: string; capitalise: boolean }[];
}) {
  const { pending, run } = useRun();
  const [c, setC] = React.useState({ category: categories[0]?.id ?? "", trip: "__all__", description: "", amount: "", basis: "" });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={c.category} onValueChange={(v) => setC({ ...c, category: v })}><SelectTrigger className="h-8 w-56"><SelectValue placeholder="Category" /></SelectTrigger>
        <SelectContent>{categories.map((x) => <SelectItem key={x.id} value={x.id}>{x.label}{x.capitalise ? "" : " (expensed)"}</SelectItem>)}</SelectContent></Select>
      <Select value={c.trip} onValueChange={(v) => setC({ ...c, trip: v })}><SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="__all__">Whole transfer</SelectItem>{trips.map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}</SelectContent></Select>
      <Input className="h-8 w-44" placeholder="Description" value={c.description} onChange={(e) => setC({ ...c, description: e.target.value })} />
      <Input className="h-8 w-32 text-right" type="number" min="0" step="0.01" placeholder="TZS estimate" value={c.amount} onChange={(e) => setC({ ...c, amount: e.target.value })} />
      <Select value={c.basis || "__default__"} onValueChange={(v) => setC({ ...c, basis: v === "__default__" ? "" : v })}><SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="__default__">By net kg (default)</SelectItem><SelectItem value="value">By value</SelectItem><SelectItem value="quantity">By units</SelectItem></SelectContent></Select>
      <Button size="sm" variant="outline" disabled={pending || !c.category} onClick={async () => {
        const e = await run(() => addTransferCharge({ transferId, tripId: c.trip === "__all__" ? null : c.trip, categoryId: c.category, description: c.description, amount: Number(c.amount || 0), basis: c.basis || null }), "Charge added (estimate).");
        if (!e) setC({ ...c, description: "", amount: "" });
      }}>Add charge</Button>
    </div>
  );
}

export function ChargeRowActions({ sourceId, status, estimate, canAccrue }: { sourceId: string; status: string; estimate: number; canAccrue: boolean }) {
  const { pending, run } = useRun();
  const [amount, setAmount] = React.useState(String(estimate || ""));
  const [date, setDate] = React.useState(todayISO());
  if (status !== "estimated") return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {canAccrue && <>
        <Input className="h-7 w-28 text-right" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Input className="h-7 w-36" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <Button size="sm" disabled={pending} onClick={() => run(() => accrueTransferCharge(sourceId, Number(amount || 0), date), "Charge accrued.")}>Accrue</Button>
      </>}
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => voidTransferChargeEstimate(sourceId), "Estimate removed.")}>Remove</Button>
    </div>
  );
}
