"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Loader2, PackageCheck } from "lucide-react";
import { receiveTrip, addArrivalCharges } from "@/lib/transfers/actions";
import { formatDateTime, formatMoney, formatQuantity } from "@/lib/format";
import { normaliseRegistration } from "@/lib/transfers/registration";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface InTransitTruck {
  id: string; transferId: string; transfer: string; trip: string; deliveryNote: string | null; from: string; to: string; toId: string;
  vehicle: string | null; trailer: string | null; driver: string | null; driverPhone: string | null; dispatchedAt: string | null; eta: string | null;
  lines: { id: string; name: string; unit: string; open: number }[];
}
type Qty = { accepted: string; damaged: string; short: string };

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-recv`);
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const num = (v: string) => (v.trim() === "" ? 0 : Number(v));

export function BulkReceiveForm({ trucks, branches, chargesEnabled, categories }: {
  trucks: InTransitTruck[]; branches: { id: string; name: string }[]; chargesEnabled: boolean; categories: { id: string; code: string; name: string }[];
}) {
  const router = useRouter();
  const [branch, setBranch] = React.useState(branches.length === 1 ? branches[0].id : "");
  const [search, setSearch] = React.useState("");
  const [ticked, setTicked] = React.useState<Set<string>>(new Set());
  const [qty, setQty] = React.useState<Record<string, Qty>>({});
  const [arrived, setArrived] = React.useState(localNow);
  const [signedBy, setSignedBy] = React.useState("");
  const [review, setReview] = React.useState(false);
  const [running, setRunning] = React.useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = React.useState<Record<string, string>>({});
  // Offloading: one rate for all ticked trucks (per truck or per bag offloaded); each truck's amount can be changed.
  const [chargeType, setChargeType] = React.useState(() => categories.find((c) => c.code === "LOADING")?.id ?? categories[0]?.id ?? "");
  const [basis, setBasis] = React.useState<"truck" | "bag">("truck");
  const [rate, setRate] = React.useState("");
  const [override, setOverride] = React.useState<Record<string, string>>({});
  // One retry key per truck for this page: pressing again never receives a truck twice.
  const keys = React.useRef<Record<string, string>>({});

  const shown = trucks.filter((t) => (!branch || t.toId === branch)
    && (!search.trim() || normaliseRegistration(`${t.vehicle ?? ""}${t.trailer ?? ""}`).includes(normaliseRegistration(search)) || `${t.driver ?? ""} ${t.trip} ${t.deliveryNote ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())));
  const chosen = trucks.filter((t) => ticked.has(t.id));
  const q = (lineId: string, open: number): Qty => qty[lineId] ?? { accepted: String(open), damaged: "", short: "" };
  const setQ = (lineId: string, open: number, k: keyof Qty, v: string) => setQty((s) => ({ ...s, [lineId]: { ...q(lineId, open), [k]: v } }));
  const toggle = (id: string, on: boolean) => setTicked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  const problems = chosen.flatMap((t) => {
    const out: string[] = [];
    let any = 0;
    for (const l of t.lines) {
      const v = q(l.id, l.open);
      const a = num(v.accepted), d = num(v.damaged), s = num(v.short);
      if ([a, d, s].some((x) => !Number.isFinite(x) || x < 0)) out.push(`${t.vehicle ?? t.trip}: quantities must be numbers, not below zero.`);
      else if (a + d + s > l.open + 1e-9) out.push(`${t.vehicle ?? t.trip}: ${l.name} is more than the ${formatQuantity(l.open)} on the truck.`);
      any += a + d + s;
    }
    if (any <= 0) out.push(`${t.vehicle ?? t.trip}: enter what arrived.`);
    return out;
  });
  const totals = chosen.reduce((acc, t) => {
    for (const l of t.lines) { const v = q(l.id, l.open); acc.accepted += num(v.accepted) || 0; acc.damaged += num(v.damaged) || 0; acc.short += num(v.short) || 0; acc.loaded += l.open; }
    return acc;
  }, { loaded: 0, accepted: 0, damaged: 0, short: 0 });
  // Bags offloaded = received + damaged (short never arrived).
  const offloaded = (t: InTransitTruck) => t.lines.reduce((a, l) => { const v = q(l.id, l.open); return a + (num(v.accepted) || 0) + (num(v.damaged) || 0); }, 0);
  const computed = (t: InTransitTruck) => { const r = num(rate) || 0; return Math.round((basis === "truck" ? r : r * offloaded(t)) * 100) / 100; };
  const charge = (t: InTransitTruck) => (override[t.id] !== undefined ? num(override[t.id]) || 0 : computed(t));
  const chargeTotal = chosen.reduce((a, t) => a + charge(t), 0);
  if (chargesEnabled && chargeTotal > 0 && !chargeType) problems.push("Choose the charge type for offloading.");
  if (chosen.some((t) => override[t.id] !== undefined && !(num(override[t.id]) >= 0))) problems.push("Offloading amounts cannot be negative.");
  const ready = chosen.length > 0 && problems.length === 0 && !!arrived;

  async function receiveAll() {
    setRunning({ done: 0, total: chosen.length });
    const errors: Record<string, string> = {};
    const chargeErrors: string[] = [];
    let ok = 0;
    for (const [i, t] of chosen.entries()) {
      keys.current[t.id] ??= rid();
      const res = await receiveTrip({
        tripId: t.id, arrivedAt: arrived ? new Date(arrived).toISOString() : null, signedBy, requestId: keys.current[t.id],
        lines: t.lines.map((l) => { const v = q(l.id, l.open); return { dispatch_line_id: l.id, accepted: num(v.accepted), quarantined: num(v.damaged), short: num(v.short) }; }),
      });
      if (res.ok) {
        ok++;
        const amount = chargesEnabled ? charge(t) : 0;
        if (amount > 0) {
          // Booked after the receipt so the charge lands on the goods received (as on the single-truck screen).
          const c = await addArrivalCharges({ transferId: t.transferId, tripId: t.id, date: (arrived || new Date().toISOString()).slice(0, 10),
            charges: [{ categoryId: chargeType, amount, description: basis === "bag" ? `Offloading ${formatQuantity(offloaded(t))} bags @ ${rate}` : "Offloading" }] });
          if (!c.ok) chargeErrors.push(`${t.vehicle ?? t.trip}: ${c.error ?? "charge not recorded"}`);
        }
      } else errors[t.id] = res.error ?? "Failed.";
      setRunning({ done: i + 1, total: chosen.length });
    }
    setRunning(null); setReview(false); setFailed(errors);
    // Keep only the trucks that failed ticked, so they can be fixed and tried again.
    setTicked(new Set(Object.keys(errors)));
    if (ok) toast.success(`${ok} truck${ok === 1 ? "" : "s"} received.`);
    if (Object.keys(errors).length) toast.error(`${Object.keys(errors).length} truck(s) could not be received; see the message on each.`);
    if (chargeErrors.length) toast.error(`Received, but offloading was not recorded for: ${chargeErrors.join("; ")}. Add it on the transfer.`, { duration: 15000 });
    setOverride({});
    router.refresh();
  }

  return (
    <div className="space-y-4 pb-28">
      <Card><CardContent className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-4 sm:p-5">
        {branches.length > 1 && (
          <div className="space-y-1.5"><Label>Receiving branch</Label>
            <select className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm" value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">All my branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></div>
        )}
        <div className="space-y-1.5"><Label>Find truck / driver / DN</Label><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. T459DQD" /></div>
        <div className="space-y-1.5"><Label>Arrived on *</Label><Input type="datetime-local" value={arrived} onChange={(e) => setArrived(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Signed for by (name)</Label><Input value={signedBy} onChange={(e) => setSignedBy(e.target.value)} /></div>
        <div className="flex items-end gap-2 sm:col-span-4">
          <Button type="button" variant="outline" size="sm" onClick={() => setTicked(new Set([...ticked, ...shown.map((t) => t.id)]))}>Tick all shown ({shown.length})</Button>
          {ticked.size > 0 && <Button type="button" variant="ghost" size="sm" onClick={() => setTicked(new Set())}>Clear ({ticked.size})</Button>}
        </div>
      </CardContent></Card>

      {chargesEnabled && categories.length > 0 && (
        <Card><CardContent className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-4 sm:p-5">
          <div className="sm:col-span-4">
            <p className="font-semibold">Offloading charges</p>
            <p className="text-xs text-muted-foreground">Paid by this branch on arrival and added to the cost of the goods received. Leave the rate empty if there is no charge; each truck&apos;s amount can be changed below.</p>
          </div>
          <div className="space-y-1.5"><Label>Charge type</Label>
            <select className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm" value={chargeType} onChange={(e) => setChargeType(e.target.value)}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div className="space-y-1.5"><Label>Rate</Label>
            <select className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm" value={basis} onChange={(e) => { setBasis(e.target.value as "truck" | "bag"); setOverride({}); }}>
              <option value="truck">Per truck</option><option value="bag">Per bag offloaded</option>
            </select></div>
          <div className="space-y-1.5"><Label>Amount (TZS) {basis === "truck" ? "per truck" : "per bag"}</Label>
            <Input inputMode="decimal" type="number" min="0" step="any" value={rate} onChange={(e) => { setRate(e.target.value); setOverride({}); }} placeholder="0" /></div>
          <div className="flex items-end text-sm">{chosen.length > 0 && chargeTotal > 0 && <span>Total for ticked trucks: <span className="font-semibold">{formatMoney(chargeTotal)}</span></span>}</div>
        </CardContent></Card>
      )}

      <div className="space-y-3">
        {shown.map((t) => {
          const on = ticked.has(t.id);
          const late = !!t.eta && new Date(t.eta).getTime() < Date.parse(arrived || "");
          return (
            <Card key={t.id} className={on ? "border-primary ring-1 ring-primary" : ""}>
              <CardContent className="space-y-3 p-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <Checkbox className="mt-1 h-5 w-5" checked={on} onCheckedChange={(v) => toggle(t.id, v === true)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-semibold">{t.vehicle ?? "—"}</span>
                      {t.trailer && <span className="text-sm text-muted-foreground">/ {t.trailer}</span>}
                      {late && <Badge variant="destructive">late</Badge>}
                      {failed[t.id] && <Badge variant="destructive">not received</Badge>}
                    </span>
                    <span className="block text-sm">{t.driver ?? "—"}{t.driverPhone ? ` · ${t.driverPhone}` : ""}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t.from} → {t.to} · {t.trip}{t.deliveryNote ? ` · DN ${t.deliveryNote}` : ""} · loaded {t.dispatchedAt ? formatDateTime(t.dispatchedAt) : "—"} · ETA {t.eta ? formatDateTime(t.eta) : "—"}
                    </span>
                    {!on && <span className="mt-1 block text-sm">{t.lines.map((l) => `${formatQuantity(l.open)} ${l.unit} ${l.name}`).join(" · ")}</span>}
                  </span>
                  <Link href={`/inventory/transfers/${t.transferId}`} className="shrink-0 text-xs text-primary underline">Open</Link>
                </label>
                {failed[t.id] && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{failed[t.id]}</p>}
                {on && chargesEnabled && categories.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm">
                    <span className="flex-1">Offloading for this truck (TZS){basis === "bag" ? ` · ${formatQuantity(offloaded(t))} bags` : ""}</span>
                    <Input inputMode="decimal" type="number" min="0" step="any" className="h-10 w-36 text-right tabular-nums sm:h-8"
                      value={override[t.id] ?? (computed(t) ? String(computed(t)) : "")} placeholder="0"
                      onChange={(e) => setOverride((s) => ({ ...s, [t.id]: e.target.value }))} />
                  </div>
                )}
                {on && t.lines.map((l) => {
                  const v = q(l.id, l.open);
                  const rest = l.open - (num(v.accepted) || 0) - (num(v.damaged) || 0) - (num(v.short) || 0);
                  return (
                    <div key={l.id} className="rounded-md border border-border p-3">
                      <p className="mb-2 text-sm font-medium">{l.name} <span className="font-normal text-muted-foreground">· {formatQuantity(l.open)} {l.unit} on the truck</span></p>
                      <div className="grid grid-cols-3 gap-2">
                        {([["accepted", "Received"], ["damaged", "Damaged"], ["short", "Short"]] as const).map(([k, label]) => (
                          <div key={k} className="space-y-1"><Label className="text-xs">{label}</Label>
                            <Input inputMode="decimal" type="number" min="0" step="1" className="h-11 text-right text-base tabular-nums sm:h-9" value={v[k]}
                              onChange={(e) => setQ(l.id, l.open, k, e.target.value)} /></div>
                        ))}
                      </div>
                      {Math.abs(rest) > 1e-9 && <p className={`mt-1 text-xs ${rest < 0 ? "text-destructive" : "text-muted-foreground"}`}>{rest < 0 ? `${formatQuantity(-rest)} more than on the truck` : `${formatQuantity(rest)} not yet arrived (stays in transit)`}</p>}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
        {shown.length === 0 && <p className="text-sm text-muted-foreground">No truck matches.</p>}
      </div>

      {/* Always-visible bar: what is ticked, and the next step. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">
            <span className="font-semibold">{chosen.length}</span> truck{chosen.length === 1 ? "" : "s"} ticked
            {chosen.length > 0 && <> · received {formatQuantity(totals.accepted)}{totals.damaged ? ` · damaged ${formatQuantity(totals.damaged)}` : ""}{totals.short ? ` · short ${formatQuantity(totals.short)}` : ""}</>}
            {problems.length > 0 && <span className="block text-xs text-destructive">{problems[0]}{problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}</span>}
          </p>
          <Button className="h-11 sm:h-9" disabled={!ready} onClick={() => setReview(true)}><PackageCheck className="h-4 w-4" /> Review and receive {chosen.length || ""}</Button>
        </div>
      </div>

      <Dialog open={review} onOpenChange={(o) => !running && setReview(o)}>
        <DialogContent className="flex h-[100dvh] max-h-[100dvh] w-full max-w-full flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-auto sm:max-h-[90vh] sm:max-w-2xl sm:rounded-lg sm:border">
          <DialogHeader className="border-b border-border pb-3 pl-4 pr-12 pt-4 sm:pl-6 sm:pt-6">
            <DialogTitle>Confirm receiving {chosen.length} truck{chosen.length === 1 ? "" : "s"}</DialogTitle>
            <DialogDescription>Arrived {arrived ? new Date(arrived).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—"}{signedBy ? ` · signed for by ${signedBy}` : ""}. Good goods go into stock now; damaged and short go to discrepancies for an approver.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
            <ul className="divide-y divide-border text-sm">
              {chosen.map((t) => (
                <li key={t.id} className="py-2">
                  <p className="font-semibold">{t.vehicle ?? t.trip}{t.trailer ? ` / ${t.trailer}` : ""} <span className="font-normal text-muted-foreground">· {t.driver ?? "—"} · {t.from} → {t.to}</span></p>
                  {t.lines.map((l) => { const v = q(l.id, l.open); return (
                    <p key={l.id} className="text-muted-foreground">{l.name}: <span className="font-medium text-foreground">{formatQuantity(num(v.accepted) || 0)}</span> received
                      {num(v.damaged) ? <span className="text-destructive"> · {formatQuantity(num(v.damaged))} damaged</span> : null}
                      {num(v.short) ? <span className="text-destructive"> · {formatQuantity(num(v.short))} short</span> : null} of {formatQuantity(l.open)} {l.unit}</p>
                  ); })}
                  {chargesEnabled && charge(t) > 0 && <p className="text-muted-foreground">Offloading: <span className="font-medium text-foreground">{formatMoney(charge(t))}</span></p>}
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-2 border-t border-border bg-card px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-6">
            <p className="text-sm">Total received <span className="font-semibold">{formatQuantity(totals.accepted)}</span> of {formatQuantity(totals.loaded)} loaded
              {totals.damaged ? ` · damaged ${formatQuantity(totals.damaged)}` : ""}{totals.short ? ` · short ${formatQuantity(totals.short)}` : ""}
              {chargesEnabled && chargeTotal > 0 ? <> · offloading <span className="font-semibold">{formatMoney(chargeTotal)}</span></> : null}</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" className="h-11 sm:h-9" onClick={() => setReview(false)} disabled={!!running}>Back</Button>
              <Button className="h-11 sm:h-9" onClick={receiveAll} disabled={!!running}>
                {running ? <><Loader2 className="h-4 w-4 animate-spin" /> Receiving {running.done + 1 > running.total ? running.total : running.done + 1} of {running.total}…</>
                  : <><CheckCircle2 className="h-4 w-4" /> Confirm receiving {chosen.length}</>}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
