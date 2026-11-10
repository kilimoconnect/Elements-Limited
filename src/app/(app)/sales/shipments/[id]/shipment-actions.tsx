"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, ClipboardList, PackageCheck, Truck, CheckCircle2 } from "lucide-react";
import { cancelShipment, dispatchShipment, issueLoadingOrder, recordDelivery, recordLoading } from "@/lib/sales/fulfilment-actions";
import { formatQuantity } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PhoneInput } from "@/components/common/phone-input";

interface L { id: string; label: string; unit: string; planned: number; loaded: number | null; dispatched: number; batch: string; maxLoad: number }

/** The next step for this truck: loading order -> actual loading -> dispatch -> collection / delivery. */
export function ShipmentActions({ id, status, collection, onHold, canFulfil, lines }: {
  id: string; status: string; collection: boolean; onHold: boolean; canFulfil: boolean; lines: L[];
}) {
  const router = useRouter();
  const [load, setLoad] = React.useState<Record<string, { qty: string; batch: string }>>(
    Object.fromEntries(lines.map((l) => [l.id, { qty: String(l.loaded ?? l.planned), batch: l.batch }])));
  const [checked, setChecked] = React.useState(false);
  const [del, setDel] = React.useState<Record<string, { short: string; damaged: string }>>({});
  const [recipient, setRecipient] = React.useState({ name: "", phone: "", notes: "" });
  const [cancel, setCancel] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [idem] = React.useState(() => ({ current: crypto.randomUUID() }));
  if (!canFulfil || status === "cancelled" || status === "delivered" || status === "collected") return null;

  async function run(p: Promise<{ ok: boolean; error?: string }>, msg: string) {
    setError(null);
    const r = await p;
    if (!r.ok) { setError(r.error ?? "Failed."); return; }
    toast.success(msg); router.refresh();
  }
  const before = ["planned", "loading_order_issued", "loaded"].includes(status);
  const overLoad = lines.filter((l) => Number(load[l.id]?.qty || 0) > l.maxLoad + 0.00005);

  return (
    <Card className="border-primary/40">
      <CardContent className="space-y-3 p-4 sm:p-5">
        {status === "planned" && (
          <>
            <p className="font-medium">Next: issue the loading order</p>
            <p className="text-sm text-muted-foreground">It gets its own LO number and instructs the store to load exactly the planned quantities.</p>
            <Button onClick={() => run(issueLoadingOrder(id), "Loading order issued.")} disabled={onHold}><ClipboardList className="h-4 w-4" /> Issue loading order</Button>
          </>
        )}

        {(status === "loading_order_issued" || status === "loaded") && (
          <>
            <p className="font-medium">{status === "loaded" ? "Loaded — correct if needed, then dispatch" : "Next: record the actual quantity loaded"}</p>
            {lines.map((l) => (
              <div key={l.id} className="grid grid-cols-1 gap-2 rounded-md border border-border p-2 text-sm sm:grid-cols-[1fr_130px_150px] sm:items-center">
                <span>{l.label}<span className="block text-xs text-muted-foreground">Planned {formatQuantity(l.planned)} {l.unit} · max {formatQuantity(l.maxLoad)}</span></span>
                <Input className={`h-8 text-right tabular-nums ${overLoad.includes(l) ? "border-destructive" : ""}`} type="number" min="0" step="0.0001" aria-label="Loaded quantity"
                  value={load[l.id]?.qty ?? ""} onChange={(e) => setLoad({ ...load, [l.id]: { ...load[l.id], qty: e.target.value } })} />
                <Input className="h-8" placeholder="Batch / lot (optional)" value={load[l.id]?.batch ?? ""} onChange={(e) => setLoad({ ...load, [l.id]: { ...load[l.id], batch: e.target.value } })} />
              </div>
            ))}
            {overLoad.length > 0 && <p className="text-xs text-destructive">More than the approved balance. Request an amendment to increase the order.</p>}
            <Button variant={status === "loaded" ? "outline" : "default"} disabled={onHold || overLoad.length > 0}
              onClick={() => run(recordLoading(id, lines.map((l) => ({ shipment_line_id: l.id, qty_loaded: Number(load[l.id]?.qty || 0), batch: load[l.id]?.batch }))), "Loading recorded.")}>
              <PackageCheck className="h-4 w-4" /> {status === "loaded" ? "Update loading" : "Record loading"}
            </Button>
          </>
        )}

        {status === "loaded" && (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="font-medium">Dispatch confirmation</p>
            <p className="text-sm text-muted-foreground">Dispatch takes the loaded goods out of stock, issues this truck’s commercial invoice paid from the customer’s committed funds, and the delivery note. It happens once.</p>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
              <span>I checked the loaded quantities, the vehicle and driver{collection ? " / collector authority" : ""} and the documents.</span>
            </label>
            <Button onClick={() => run(dispatchShipment(id, checked, idem.current), "Dispatched. Invoice and delivery note issued.")} disabled={!checked || onHold}><Truck className="h-4 w-4" /> Confirm dispatch</Button>
          </div>
        )}

        {(status === "dispatched" || status === "in_transit") && (
          <>
            <p className="font-medium">{collection ? "Record collection" : "Record delivery"}</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1"><Label>Received by</Label><Input value={recipient.name} onChange={(e) => setRecipient({ ...recipient, name: e.target.value })} /></div>
              <div className="space-y-1"><Label>Phone</Label><PhoneInput value={recipient.phone} onChange={(e) => setRecipient({ ...recipient, phone: e.target.value })} /></div>
            </div>
            {lines.filter((l) => l.dispatched > 0).map((l) => (
              <div key={l.id} className="grid grid-cols-2 gap-2 rounded-md border border-border p-2 text-sm sm:grid-cols-[1fr_110px_110px] sm:items-center">
                <span className="col-span-2 sm:col-span-1">{l.label}<span className="block text-xs text-muted-foreground">Dispatched {formatQuantity(l.dispatched)} {l.unit}</span></span>
                <Input className="h-8 text-right" type="number" min="0" step="0.0001" placeholder="Short" value={del[l.id]?.short ?? ""} onChange={(e) => setDel({ ...del, [l.id]: { ...del[l.id], short: e.target.value } })} />
                <Input className="h-8 text-right" type="number" min="0" step="0.0001" placeholder="Damaged" value={del[l.id]?.damaged ?? ""} onChange={(e) => setDel({ ...del, [l.id]: { ...del[l.id], damaged: e.target.value } })} />
              </div>
            ))}
            <Textarea rows={2} placeholder="Notes (optional)" value={recipient.notes} onChange={(e) => setRecipient({ ...recipient, notes: e.target.value })} />
            <p className="text-xs text-muted-foreground">Shortages and damage become exceptions for a manager. Stock is not restored automatically. Attach the signed delivery note or collection acknowledgement below.</p>
            <Button disabled={!recipient.name.trim()} onClick={() => run(recordDelivery(id, {
              recipient_name: recipient.name, recipient_phone: recipient.phone, notes: recipient.notes,
              lines: lines.filter((l) => l.dispatched > 0).map((l) => {
                const sh = Number(del[l.id]?.short || 0), dm = Number(del[l.id]?.damaged || 0);
                return { shipment_line_id: l.id, qty_short: sh, qty_damaged: dm, qty_accepted: Math.round((l.dispatched - sh - dm) * 10000) / 10000 };
              }),
            }), collection ? "Collection recorded." : "Delivery recorded.")}>
              <CheckCircle2 className="h-4 w-4" /> {collection ? "Confirm collected" : "Confirm delivered"}
            </Button>
          </>
        )}

        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        {before && <div className="border-t border-border pt-3"><Button variant="outline" size="sm" onClick={() => setCancel(true)}><Ban className="h-4 w-4" /> Cancel truck</Button></div>}
        <ConfirmDialog open={cancel} onOpenChange={setCancel} title="Cancel this truck?" description="Its quantities go back to the order balance. Nothing was posted." confirmLabel="Cancel truck" destructive requireReason
          onConfirm={async (reason) => { const r = await cancelShipment(id, reason); if (!r.ok) return r.error; toast.success("Truck cancelled."); router.refresh(); }} />
      </CardContent>
    </Card>
  );
}
