"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createTrip } from "@/lib/transfers/actions";
import { formatQuantity } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-trip`);

export function TripForm({ transferId, lines, canLicence, defaults }: {
  transferId: string; lines: { id: string; label: string; remaining: number; kgPerUnit: number | null }[]; canLicence: boolean;
  defaults: { driverName: string; driverPhone: string; vehicle: string; trailer: string; expected: string };
}) {
  const router = useRouter();
  const [qty, setQty] = React.useState<Record<string, string>>(Object.fromEntries(lines.map((l) => [l.id, String(l.remaining)])));
  const [f, setF] = React.useState({
    dispatchDate: new Date().toISOString().slice(0, 10), expected: defaults.expected ? `${defaults.expected}T12:00` : "",
    driverName: defaults.driverName, driverPhone: defaults.driverPhone, driverLicence: "", vehicle: defaults.vehicle, trailer: defaults.trailer,
    transporter: "", transporterContact: "", notes: "",
  });
  const [requestId] = React.useState(rid);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const totalKg = lines.reduce((a, l) => a + Number(qty[l.id] || 0) * (l.kgPerUnit ?? 0), 0);

  async function submit() {
    setError(null); setPending(true);
    const res = await createTrip({
      transferId, dispatchDate: f.dispatchDate, expectedArrivalAt: f.expected ? new Date(f.expected).toISOString() : null,
      driverName: f.driverName, driverPhone: f.driverPhone, driverLicence: canLicence ? f.driverLicence : undefined,
      vehicleRegistration: f.vehicle, trailerRegistration: f.trailer, transporterName: f.transporter, transporterContact: f.transporterContact, notes: f.notes,
      requestId, lines: lines.map((l) => ({ transfer_line_id: l.id, qty: Number(qty[l.id] || 0) })),
    });
    setPending(false);
    if (res.ok) { toast.success("Trip prepared. Dispatch it from the transfer page."); router.push(`/inventory/transfers/${transferId}`); }
    else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="space-y-2 p-5">
        <h3 className="font-semibold">Cargo on this truck</h3>
        {lines.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="w-72 truncate">{l.label}</span>
            <Input className="h-8 w-32 text-right tabular-nums" type="number" min="0" max={l.remaining} step="1" value={qty[l.id]} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} />
            <span className="text-xs text-muted-foreground">of {formatQuantity(l.remaining)} left{l.kgPerUnit ? ` · ${formatQuantity(Number(qty[l.id] || 0) * l.kgPerUnit)} kg` : ""}</span>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Total net kg {formatQuantity(totalKg)}</p>
      </CardContent></Card>
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
        <div className="space-y-1.5"><Label>Dispatch date</Label><Input type="date" value={f.dispatchDate} onChange={set("dispatchDate")} /></div>
        <div className="space-y-1.5"><Label>Expected arrival</Label><Input type="datetime-local" value={f.expected} onChange={set("expected")} /></div>
        <div />
        <div className="space-y-1.5"><Label>Driver name</Label><Input value={f.driverName} onChange={set("driverName")} /></div>
        <div className="space-y-1.5"><Label>Driver phone</Label><Input value={f.driverPhone} onChange={set("driverPhone")} /></div>
        {canLicence ? <div className="space-y-1.5"><Label>Licence number</Label><Input value={f.driverLicence} onChange={set("driverLicence")} /></div>
          : <p className="text-xs text-muted-foreground sm:pt-7">Licence details are recorded by users allowed to see them.</p>}
        <div className="space-y-1.5"><Label>Truck registration</Label><Input value={f.vehicle} onChange={set("vehicle")} /></div>
        <div className="space-y-1.5"><Label>Trailer registration</Label><Input value={f.trailer} onChange={set("trailer")} /></div>
        <div />
        <div className="space-y-1.5"><Label>Transporter company</Label><Input value={f.transporter} onChange={set("transporter")} /></div>
        <div className="space-y-1.5"><Label>Transporter contact</Label><Input value={f.transporterContact} onChange={set("transporterContact")} /></div>
        <div className="space-y-1.5 sm:col-span-3"><Label>Notes</Label><Textarea value={f.notes} onChange={set("notes")} /></div>
      </CardContent></Card>
      <div className="flex items-center justify-end gap-2">
        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <Button onClick={submit} disabled={pending}>{pending ? "Saving..." : "Save trip"}</Button>
      </div>
    </div>
  );
}
