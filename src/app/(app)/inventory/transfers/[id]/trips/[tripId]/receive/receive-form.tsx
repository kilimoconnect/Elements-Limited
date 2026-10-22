"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { addArrivalCharges, receiveTrip } from "@/lib/transfers/actions";
import { formatQuantity, todayISO } from "@/lib/format";
import { ChargeRows, newCharge, parseCharges, type ChargeCategory, type ChargeRow } from "@/components/inventory/charge-rows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-recv`);
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export function ReceiveTripForm({ transferId, tripId, lines, chargesEnabled, categories }: {
  transferId: string; tripId: string; lines: { id: string; label: string; open: number }[];
  chargesEnabled: boolean; categories: ChargeCategory[];
}) {
  const router = useRouter();
  const [rows, setRows] = React.useState(lines.map((l) => ({ id: l.id, accepted: String(l.open), quarantined: "", short: "" })));
  const [charges, setCharges] = React.useState<ChargeRow[]>(() =>
    chargesEnabled ? [newCharge(categories.find((c) => c.code === "LOADING")?.id ?? "")] : []);
  const [arrived, setArrived] = React.useState(localNow);
  const [signedBy, setSignedBy] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [requestId, setRequestId] = React.useState(rid);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = (i: number, k: "accepted" | "quarantined" | "short", v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  async function submit() {
    setError(null);
    const parsedCharges = parseCharges(charges);
    if (!parsedCharges) { setError("Each charge needs a type and an amount above zero (remove empty rows)."); return; }
    setPending(true);
    const res = await receiveTrip({
      tripId, arrivedAt: arrived ? new Date(arrived).toISOString() : null, signedBy, notes, requestId,
      lines: rows.map((r) => ({ dispatch_line_id: r.id, accepted: Number(r.accepted || 0), quarantined: Number(r.quarantined || 0), short: Number(r.short || 0) })),
    });
    if (!res.ok) { setPending(false); setError(res.error ?? "Failed."); return; }
    toast.success("Receipt recorded.");
    if (parsedCharges.length > 0) {
      // Booked after the receipt so the charges land on the goods received.
      const c = await addArrivalCharges({ transferId, tripId, date: (arrived || todayISO()).slice(0, 10), charges: parsedCharges });
      if (c.ok) toast.success(c.message ?? "Arrival charges recorded.");
      else toast.error(`Receipt saved, but the charges were not: ${c.error ?? "failed"}. Add them on the transfer page.`);
    }
    setPending(false); setRequestId(rid()); router.push(`/inventory/transfers/${transferId}`);
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr>
            <th className="px-3 py-2 text-left">Cargo</th><th className="px-3 py-2 text-right">Still to arrive</th>
            <th className="px-3 py-2 text-right">Accepted (into stock)</th><th className="px-3 py-2 text-right">Damaged / quarantined</th><th className="px-3 py-2 text-right">Short (missing)</th>
            <th className="px-3 py-2 text-right">Not yet arrived</th>
          </tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const rest = l.open - Number(rows[i].accepted || 0) - Number(rows[i].quarantined || 0) - Number(rows[i].short || 0);
              return (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2">{l.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(l.open)}</td>
                  {(["accepted", "quarantined", "short"] as const).map((k) => (
                    <td key={k} className="px-3 py-2"><Input className="ml-auto h-8 w-28 text-right tabular-nums" type="number" min="0" step="1" value={rows[i][k]} onChange={(e) => set(i, k, e.target.value)} /></td>
                  ))}
                  <td className={`px-3 py-2 text-right tabular-nums ${rest < 0 ? "text-destructive" : ""}`}>{formatQuantity(rest)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent></Card>
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
        <div className="space-y-1.5"><Label>Actual arrival</Label><Input type="datetime-local" value={arrived} onChange={(e) => setArrived(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Signed for by (name)</Label><Input value={signedBy} onChange={(e) => setSignedBy(e.target.value)} /></div>
        <div className="space-y-1.5 sm:col-span-3"><Label>Notes</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <p className="text-xs text-muted-foreground sm:col-span-3">Upload the signed delivery note and offloading photos on the trip after saving. Shortages and quarantined goods need an approver: release, normal loss within tolerance, write-off or claim.</p>
      </CardContent></Card>
      <Card><CardContent className="space-y-3 p-5">
        <div>
          <h3 className="font-semibold">Offloading and other arrival charges</h3>
          <p className="text-xs text-muted-foreground">Paid by this branch when the goods arrive. They are added to the inventory cost of the goods received here (shared by weight).</p>
        </div>
        {chargesEnabled
          ? <ChargeRows categories={categories} rows={charges} setRows={setCharges} notePlaceholder="e.g. offloading crew, receipt no." />
          : <p className="rounded-md bg-muted px-3 py-2 text-sm">Arrival charges need <strong>Transfer logistics</strong> switched on (Admin → Feature Flags).</p>}
      </CardContent></Card>
      <div className="flex items-center justify-end gap-2">
        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <Button onClick={submit} disabled={pending}>{pending ? "Posting..." : "Record receipt"}</Button>
      </div>
    </div>
  );
}
