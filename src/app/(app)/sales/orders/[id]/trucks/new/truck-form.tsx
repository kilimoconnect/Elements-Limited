"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createShipment, type ShipmentHeaderInput } from "@/lib/sales/fulfilment-actions";
import { formatQuantity, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normaliseRegistration } from "@/lib/transfers/registration";
import { Textarea } from "@/components/ui/textarea";
import { PhoneInput } from "@/components/common/phone-input";

interface L { id: string; description: string; sku: string; unit: string; remaining: number; kgPerUnit: number | null }

/** Truck details entered the same way as a transfer trip, plus the collector or consignee of the sale. */
export function TruckForm({ orderId, mode, canLicence, defaults, lines }: {
  orderId: string; mode: string; canLicence: boolean;
  defaults: { destination: string; consignee_name: string; consignee_phone: string; dispatch_location: string }; lines: L[];
}) {
  const router = useRouter();
  const [qty, setQty] = React.useState<Record<string, string>>(Object.fromEntries(lines.map((l) => [l.id, ""])));
  const [f, setF] = React.useState({
    dispatchDate: todayISO(), expected: "", driverName: "", driverPhone: "", driverLicence: "", vehicle: "", trailer: "",
    transporter: "", transporterContact: "", notes: "",
    collectorName: "", collectorPhone: "", collectorId: "",
    destination: defaults.destination, consigneeName: defaults.consignee_name, consigneePhone: defaults.consignee_phone,
  });
  const [key] = React.useState(() => `truck:${orderId}:${crypto.randomUUID()}`);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const over = lines.filter((l) => Number(qty[l.id] || 0) > l.remaining + 0.00005);
  const total = lines.reduce((s, l) => s + Number(qty[l.id] || 0), 0);
  const totalKg = lines.reduce((a, l) => a + Number(qty[l.id] || 0) * (l.kgPerUnit ?? 0), 0);
  const blockers: string[] = [];
  if (total <= 0) blockers.push("Enter the quantity on this truck.");
  if (over.length) blockers.push(`More than the remaining balance for ${over.map((l) => l.sku).join(", ")}.`);
  if (mode === "delivery" && !f.vehicle.trim()) blockers.push("Enter the truck registration.");
  if (mode === "collection" && !f.collectorName.trim() && !f.vehicle.trim()) blockers.push("Enter the collector or the truck.");

  async function save() {
    setError(null); setPending(true);
    const header: ShipmentHeaderInput = {
      dispatch_location: defaults.dispatch_location, planned_dispatch_date: f.dispatchDate,
      expected_arrival_at: f.expected ? new Date(f.expected).toISOString() : "",
      driver_name: f.driverName, driver_phone: f.driverPhone, driver_licence: canLicence ? f.driverLicence : "",
      vehicle_registration: f.vehicle, trailer_registration: f.trailer, transporter_name: f.transporter, transporter_contact: f.transporterContact,
      notes: f.notes, collector_name: f.collectorName, collector_phone: f.collectorPhone, collector_id_number: f.collectorId,
      destination: f.destination, consignee_name: f.consigneeName, consignee_phone: f.consigneePhone,
    };
    const r = await createShipment(orderId, key, header, lines.map((l) => ({ order_line_id: l.id, qty: Number(qty[l.id] || 0) })));
    if (!r.ok || !r.id) { setError(r.error ?? "Failed."); setPending(false); return; }
    toast.success("Truck saved. Issue the loading order next.");
    router.push(`/sales/shipments/${r.id}`);
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="space-y-2 p-5">
        <h3 className="font-semibold">Cargo on this truck</h3>
        {lines.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="w-72 truncate">{l.sku} — {l.description}</span>
            <Input className={`h-8 w-32 text-right tabular-nums ${over.includes(l) ? "border-destructive" : ""}`} type="number" min="0" max={l.remaining} step="0.0001"
              value={qty[l.id]} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} disabled={l.remaining <= 0} placeholder="Qty" />
            <span className="text-xs text-muted-foreground">of {formatQuantity(l.remaining)} {l.unit} left{l.kgPerUnit ? ` · ${formatQuantity(Number(qty[l.id] || 0) * l.kgPerUnit)} kg` : ""}</span>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Total net kg {formatQuantity(totalKg)}</p>
      </CardContent></Card>

      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
        <div className="space-y-1.5"><Label>Dispatch date</Label><Input type="date" value={f.dispatchDate} onChange={set("dispatchDate")} /></div>
        <div className="space-y-1.5"><Label>Expected arrival</Label><Input type="datetime-local" value={f.expected} onChange={set("expected")} /></div>
        <div />
        <div className="space-y-1.5"><Label>Driver name</Label><Input value={f.driverName} onChange={set("driverName")} /></div>
        <div className="space-y-1.5"><Label>Driver phone</Label><PhoneInput value={f.driverPhone} onChange={set("driverPhone")} /></div>
        {canLicence ? <div className="space-y-1.5"><Label>Licence number</Label><Input value={f.driverLicence} onChange={set("driverLicence")} /></div>
          : <p className="text-xs text-muted-foreground sm:pt-7">Licence details are recorded by users allowed to see them.</p>}
        <div className="space-y-1.5"><Label>Truck registration</Label><Input value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: normaliseRegistration(e.target.value) })} placeholder="e.g. T760DWG" /><p className="text-[11px] text-muted-foreground">Saved without spaces or dots, e.g. T760DWG</p></div>
        <div className="space-y-1.5"><Label>Trailer registration</Label><Input value={f.trailer} onChange={(e) => setF({ ...f, trailer: normaliseRegistration(e.target.value) })} /></div>
        <div />
        <div className="space-y-1.5"><Label>Transporter company</Label><Input value={f.transporter} onChange={set("transporter")} /></div>
        <div className="space-y-1.5"><Label>Transporter contact</Label><Input value={f.transporterContact} onChange={set("transporterContact")} /></div>
        <div />
        {mode === "collection" ? (
          <>
            <div className="space-y-1.5"><Label>Collector name</Label><Input value={f.collectorName} onChange={set("collectorName")} /></div>
            <div className="space-y-1.5"><Label>Collector phone</Label><PhoneInput value={f.collectorPhone} onChange={set("collectorPhone")} /></div>
            <div className="space-y-1.5"><Label>Collector ID number</Label><Input value={f.collectorId} onChange={set("collectorId")} /></div>
          </>
        ) : (
          <>
            <div className="space-y-1.5"><Label>Destination</Label><Input value={f.destination} onChange={set("destination")} /></div>
            <div className="space-y-1.5"><Label>Consignee</Label><Input value={f.consigneeName} onChange={set("consigneeName")} /></div>
            <div className="space-y-1.5"><Label>Consignee phone</Label><PhoneInput value={f.consigneePhone} onChange={set("consigneePhone")} /></div>
          </>
        )}
        <div className="space-y-1.5 sm:col-span-3"><Label>Notes</Label><Textarea value={f.notes} onChange={set("notes")} /></div>
      </CardContent></Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {blockers.length > 0 && <span className="text-xs text-muted-foreground">{blockers.join(" ")}</span>}
        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <Button onClick={save} disabled={pending || blockers.length > 0}>{pending ? "Saving..." : "Save truck"}</Button>
      </div>
    </div>
  );
}
