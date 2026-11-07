"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createShipment, type ShipmentHeaderInput } from "@/lib/sales/fulfilment-actions";
import { formatQuantity } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface L { id: string; description: string; sku: string; unit: string; remaining: number; approved: number; dispatched: number; allocated: number }

export function TruckForm({ orderId, mode, defaults, lines }: {
  orderId: string; mode: string; defaults: ShipmentHeaderInput; lines: L[];
}) {
  const router = useRouter();
  const [h, setH] = React.useState<ShipmentHeaderInput>(defaults);
  const [qty, setQty] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [key] = React.useState(() => ({ current: `truck:${orderId}:${crypto.randomUUID()}` }));
  const f = (k: keyof ShipmentHeaderInput) => ({ value: h[k] ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement>) => setH({ ...h, [k]: e.target.value }) });

  const over = lines.filter((l) => Number(qty[l.id] || 0) > l.remaining + 0.00005);
  const total = lines.reduce((s, l) => s + Number(qty[l.id] || 0), 0);
  const blockers: string[] = [];
  if (total <= 0) blockers.push("Enter the quantity to load on this truck.");
  if (over.length) blockers.push(`More than the remaining balance for ${over.map((l) => l.sku).join(", ")}.`);
  if (mode === "delivery" && !h.vehicle_registration?.trim()) blockers.push("Enter the vehicle registration.");
  if (mode === "collection" && !h.collector_name?.trim() && !h.vehicle_registration?.trim()) blockers.push("Enter the collector or the vehicle.");

  async function save() {
    setError(null); setPending(true);
    const r = await createShipment(orderId, key.current, h, lines.map((l) => ({ order_line_id: l.id, qty: Number(qty[l.id] || 0) })));
    if (!r.ok || !r.id) { setError(r.error ?? "Failed."); setPending(false); return; }
    toast.success("Truck planned. Issue the loading order next.");
    router.push(`/sales/shipments/${r.id}`);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr><th className="px-3 py-2 text-left">Product</th><th className="px-3 py-2 text-right">Approved</th><th className="px-3 py-2 text-right">Dispatched</th>
                  <th className="px-3 py-2 text-right">On other trucks</th><th className="px-3 py-2 text-right">Remaining</th><th className="px-3 py-2 text-right">This truck</th></tr>
              </thead>
              <tbody>{lines.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2">{l.description}<span className="block text-xs text-muted-foreground">{l.sku}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(l.approved)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(l.dispatched)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(l.allocated)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{formatQuantity(l.remaining)} {l.unit}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Input className={`h-8 w-24 text-right tabular-nums ${over.includes(l) ? "border-destructive" : ""}`} type="number" min="0" step="0.0001"
                        value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} disabled={l.remaining <= 0} />
                      {l.remaining > 0 && <button type="button" className="text-xs text-primary hover:underline" onClick={() => setQty({ ...qty, [l.id]: String(l.remaining) })}>All</button>}
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 sm:p-5">
          <p className="text-sm font-medium sm:col-span-2">Truck and transport</p>
          <div className="space-y-1"><Label>Vehicle registration</Label><Input {...f("vehicle_registration")} /></div>
          <div className="space-y-1"><Label>Trailer registration</Label><Input {...f("trailer_registration")} /></div>
          <div className="space-y-1"><Label>Transporter</Label><Input {...f("transporter_name")} /></div>
          <div className="space-y-1"><Label>Transporter contact</Label><Input {...f("transporter_contact")} /></div>
          <div className="space-y-1"><Label>Driver</Label><Input {...f("driver_name")} /></div>
          <div className="space-y-1"><Label>Driver phone</Label><Input {...f("driver_phone")} /></div>
          <div className="space-y-1"><Label>Driver licence number</Label><Input {...f("driver_licence")} /></div>
          <div className="space-y-1"><Label>Loading point</Label><Input {...f("dispatch_location")} /></div>
          <div className="space-y-1"><Label>Planned loading date</Label><Input type="date" {...f("planned_loading_date")} /></div>
          <div className="space-y-1"><Label>Planned dispatch date</Label><Input type="date" {...f("planned_dispatch_date")} /></div>
          {mode === "collection" ? (
            <>
              <p className="pt-2 text-sm font-medium sm:col-span-2">Collector (authorised by the customer)</p>
              <div className="space-y-1"><Label>Collector name</Label><Input {...f("collector_name")} /></div>
              <div className="space-y-1"><Label>Collector phone</Label><Input {...f("collector_phone")} /></div>
              <div className="space-y-1"><Label>Collector ID number</Label><Input {...f("collector_id_number")} /></div>
            </>
          ) : (
            <>
              <p className="pt-2 text-sm font-medium sm:col-span-2">Delivery</p>
              <div className="space-y-1 sm:col-span-2"><Label>Destination</Label><Input {...f("destination")} /></div>
              <div className="space-y-1"><Label>Consignee</Label><Input {...f("consignee_name")} /></div>
              <div className="space-y-1"><Label>Consignee phone</Label><Input {...f("consignee_phone")} /></div>
            </>
          )}
        </CardContent>
      </Card>

      {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={pending || blockers.length > 0}>{pending ? "Working..." : "Plan truck"}</Button>
        {blockers.length > 0 && <span className="text-xs text-muted-foreground">{blockers.join(" ")}</span>}
      </div>
    </div>
  );
}
