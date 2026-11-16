"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Truck, Undo2 } from "lucide-react";
import { confirmTripLoading, undoTripLoading } from "@/lib/transfers/actions";
import { normaliseRegistration } from "@/lib/transfers/registration";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface LoadingSummary {
  trip: string; from: string; to: string;
  vehicle: string | null; trailer: string | null; driver: string | null; phone: string | null; transporter: string | null;
  lines: { label: string; qty: string }[];
}

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-req`);

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex flex-col py-1.5 text-sm sm:flex-row sm:justify-between sm:gap-3 sm:py-1">
      <span className="text-xs text-muted-foreground sm:text-sm">{k}</span>
      <span className="min-w-0 break-words font-medium sm:text-right">{v || "—"}</span>
    </div>
  );
}

/**
 * Store keeper: confirm a truck is loaded, in two steps.
 * Step 1 checks the truck (registration typed from the truck itself) and ticks each cargo line.
 * Step 2 is the final confirmation: stock leaves, the delivery note and GRN are issued.
 */
export function ConfirmLoadingButton({ tripId, summary }: { tripId: string; summary: LoadingSummary }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState<1 | 2>(1);
  const [reg, setReg] = React.useState("");
  const [ticked, setTicked] = React.useState<boolean[]>([]);
  const [truckOk, setTruckOk] = React.useState(false);
  const [eta, setEta] = React.useState("");
  const [openedAt, setOpenedAt] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const want = normaliseRegistration(summary.vehicle);
  const regOk = want ? normaliseRegistration(reg) === want : truckOk;
  const linesOk = summary.lines.length > 0 && summary.lines.every((_, i) => ticked[i]);

  const etaOk = !!eta && new Date(eta).getTime() > openedAt - 60_000;
  const start = () => { setStep(1); setReg(""); setTicked(summary.lines.map(() => false)); setTruckOk(false); setEta(""); setOpenedAt(Date.now()); setErr(null); setOpen(true); };
  const confirm = async () => {
    setPending(true); setErr(null);
    const res = await confirmTripLoading(tripId, reg, new Date(eta).toISOString());
    setPending(false);
    if (!res.ok) { setErr(res.error ?? "Failed."); return; }
    toast.success(res.message ?? "Loading confirmed.");
    setOpen(false); router.refresh();
  };

  return (
    <>
      <Button size="sm" onClick={start}><Truck className="h-4 w-4" /> Confirm loading</Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="flex h-[100dvh] max-h-[100dvh] w-full max-w-full flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-auto sm:max-h-[90vh] sm:max-w-lg sm:rounded-lg sm:border">
          <DialogHeader className="border-b border-border pb-3 pl-4 pr-12 pt-4 sm:pl-6 sm:pt-6">
            <div className="mb-1 flex gap-1.5" aria-hidden>
              <span className="h-1.5 flex-1 rounded-full bg-primary" />
              <span className={`h-1.5 flex-1 rounded-full ${step === 2 ? "bg-primary" : "bg-muted"}`} />
            </div>
            <DialogTitle>Confirm loading — step {step} of 2</DialogTitle>
            <DialogDescription>{step === 1 ? "Check the truck and every cargo line against what is on the truck." : "Last check before the stock leaves the branch."}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">

          {step === 1 ? (
            <div className="space-y-4">
              <div className="rounded-md border border-border px-3 py-2">
                <Row k="Trip" v={summary.trip} />
                <Row k="From → To" v={`${summary.from} → ${summary.to}`} />
                <Row k="Truck" v={summary.vehicle} />
                <Row k="Trailer" v={summary.trailer} />
                <Row k="Driver" v={[summary.driver, summary.phone].filter(Boolean).join(" · ")} />
                {summary.transporter && <Row k="Transporter" v={summary.transporter} />}
              </div>
              {want ? (
                <div className="space-y-1">
                  <Label>Type the truck registration as written on the truck *</Label>
                  <Input value={reg} onChange={(e) => setReg(normaliseRegistration(e.target.value))} placeholder="e.g. T760DWG" autoComplete="off"
                    autoCapitalize="characters" autoCorrect="off" spellCheck={false} className="h-12 text-lg font-semibold tracking-wider" />
                  {reg && !regOk && <p className="text-xs text-destructive">Does not match this order ({summary.vehicle}). Check you are at the right truck.</p>}
                  {regOk && <p className="text-xs text-green-700 dark:text-green-400">Truck matches the order.</p>}
                </div>
              ) : (
                <label className="flex items-center gap-3 rounded-md border border-border p-3 text-sm"><Checkbox className="h-5 w-5" checked={truckOk} onCheckedChange={(v) => setTruckOk(v === true)} /> I checked the truck and driver</label>
              )}
              <div className="space-y-2">
                <p className="text-sm font-medium">Tick each line after counting it on the truck</p>
                {summary.lines.map((l, i) => (
                  <label key={i} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${ticked[i] ? "border-primary bg-primary/5" : "border-border"}`}>
                    <Checkbox className="mt-0.5 h-5 w-5" checked={!!ticked[i]} onCheckedChange={(v) => setTicked((t) => t.map((x, j) => (j === i ? v === true : x)))} />
                    <span className="min-w-0 flex-1 break-words">{l.label}</span><span className="shrink-0 text-base font-semibold tabular-nums">{l.qty}</span>
                  </label>
                ))}
                <p className="text-xs text-muted-foreground">If a quantity is different, cancel and use Change next to Loaded first.</p>
              </div>
              <div className="space-y-1">
                <Label>Expected arrival at {summary.to} *</Label>
                <Input type="datetime-local" value={eta} onChange={(e) => setEta(e.target.value)} className="h-12 text-base" />
                {eta && !etaOk && <p className="text-xs text-destructive">The expected arrival must be later than now.</p>}
                <p className="text-xs text-muted-foreground">The dispatch date is set to today automatically when you confirm.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-base">You confirm that truck <span className="font-semibold">{summary.vehicle ?? "—"}</span>{summary.trailer ? <> with trailer <span className="font-semibold">{summary.trailer}</span></> : null} is loaded with:</p>
              <ul className="list-disc space-y-1 break-words pl-5">{summary.lines.map((l, i) => <li key={i}><span className="font-semibold tabular-nums">{l.qty}</span> {l.label}</li>)}</ul>
              <p>for <span className="font-semibold">{summary.to}</span>, dispatched today, expected to arrive <span className="font-semibold">{eta ? new Date(eta).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—"}</span>. The stock leaves {summary.from}, goes in transit, and the delivery note and GRN are issued. Only an admin can undo this.</p>
            </div>
          )}

          </div>
          <div className="space-y-2 border-t border-border bg-card px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-6">
            {err && <p className="text-sm text-destructive">{err}</p>}
            {step === 1 && !(regOk && linesOk && etaOk) && (
              <p className="text-xs text-muted-foreground">Still needed: {[!regOk && (want ? "truck registration" : "truck checked"), !linesOk && "tick every cargo line", !etaOk && "expected arrival"].filter(Boolean).join(", ")}</p>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {step === 1 ? (
                <>
                  <Button variant="outline" className="h-11 sm:h-9" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button className="h-11 sm:h-9" disabled={!regOk || !linesOk || !etaOk} onClick={() => setStep(2)}>Next</Button>
                </>
              ) : (
                <>
                  <Button variant="outline" className="h-11 sm:h-9" onClick={() => setStep(1)} disabled={pending}>Back</Button>
                  <Button className="h-11 sm:h-9" onClick={confirm} disabled={pending}><CheckCircle2 className="h-4 w-4" /> {pending ? "Confirming..." : "Confirm loaded"}</Button>
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Admin: undo a loading confirmation made by mistake. The truck waits for loading again. */
export function UndoLoadingButton({ tripId, trip }: { tripId: string; trip: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [requestId, setRequestId] = React.useState(rid);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => { setReason(""); setErr(null); setRequestId(rid()); setOpen(true); }}><Undo2 className="h-4 w-4" /> Undo loading confirmation</Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Undo loading confirmation of {trip}?</DialogTitle>
            <DialogDescription>The stock returns to the sending branch, the delivery note is voided, and the same truck and cargo wait for loading again, to be corrected and confirmed. Only while nothing has arrived.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1"><Label>Reason *</Label><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What was wrong" /></div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button variant="destructive" disabled={pending || !reason.trim()} onClick={async () => {
              setPending(true); setErr(null);
              const res = await undoTripLoading(tripId, reason, requestId);
              setPending(false);
              if (!res.ok) { setErr(res.error ?? "Failed."); return; }
              toast.success("Loading confirmation undone. The truck waits for loading again.");
              setOpen(false); router.refresh();
            }}>{pending ? "Undoing..." : "Undo"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
