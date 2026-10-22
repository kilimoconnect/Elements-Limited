"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createTransferWithTrip } from "@/lib/transfers/actions";
import { todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { StockLineEditor, newLine, type ProductOption, type StockLine } from "@/components/inventory/stock-line-editor";
import { ChargeRows, newCharge, parseCharges, type ChargeCategory, type ChargeRow } from "@/components/inventory/charge-rows";

type Branch = { id: string; name: string; code: string };
const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-transfer`);

export function NewTransferForm({
  products, sourceBranches, allBranches, sourceBranchId, canDispatch, canLicence, chargesEnabled, categories,
}: {
  products: ProductOption[]; sourceBranches: Branch[]; allBranches: Branch[]; sourceBranchId: string;
  canDispatch: boolean; canLicence: boolean; chargesEnabled: boolean; categories: ChargeCategory[];
}) {
  const router = useRouter();
  const [source, setSource] = React.useState(sourceBranches.some((b) => b.id === sourceBranchId) ? sourceBranchId : sourceBranches[0]?.id ?? "");
  const [dest, setDest] = React.useState("");
  const [date, setDate] = React.useState(todayISO());
  const [expected, setExpected] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [lines, setLines] = React.useState<StockLine[]>([newLine()]);
  const [tp, setTp] = React.useState({
    driverName: "", driverPhone: "", driverLicence: "", vehicleRegistration: "", trailerRegistration: "", transporterName: "", transporterContact: "",
  });
  const byCode = (code: string) => categories.find((c) => c.code === code)?.id ?? "";
  const [charges, setCharges] = React.useState<ChargeRow[]>(() =>
    chargesEnabled ? [newCharge(byCode("LOADING")), newCharge(byCode("TRANSPORT"))] : []);
  const [requestId] = React.useState(rid);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const setT = (k: keyof typeof tp) => (e: React.ChangeEvent<HTMLInputElement>) => setTp({ ...tp, [k]: e.target.value });

  async function submit(dispatch: boolean) {
    setError(null);
    if (!dest) { setError("Choose the receiving branch."); return; }
    if (dest === source) { setError("Sending and receiving branches must differ."); return; }
    const parsed = lines.filter((l) => l.product_id && Number(l.quantity) > 0).map((l) => ({ product_id: l.product_id, qty: Number(l.quantity) }));
    if (parsed.length === 0) { setError("Add at least one product line."); return; }
    if (!tp.vehicleRegistration.trim() || !tp.driverName.trim()) { setError("Enter the truck registration and the driver's name."); return; }
    const parsedCharges = parseCharges(charges);
    if (!parsedCharges) { setError("Each charge needs a type and an amount above zero (remove empty rows)."); return; }
    setPending(true);
    const res = await createTransferWithTrip({
      sourceBranchId: source, destinationBranchId: dest, transferDate: date,
      expectedArrivalAt: expected ? new Date(expected).toISOString() : null, reference, notes, requestId, dispatch,
      lines: parsed, transport: { ...tp, driverLicence: canLicence ? tp.driverLicence : undefined }, charges: parsedCharges,
    });
    setPending(false);
    if (res.ok && res.id) {
      toast.success(res.message ?? (dispatch ? "Transfer dispatched." : "Transfer saved."));
      router.push(`/inventory/transfers/${res.id}`);
    } else if (res.id) {
      toast.error(res.error ?? "Failed.");
      router.push(`/inventory/transfers/${res.id}`);
    } else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="space-y-4 p-5">
        <h3 className="font-semibold">Route</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div className="space-y-1.5"><Label>From branch</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger><SelectValue placeholder="Sending branch" /></SelectTrigger>
              <SelectContent>{sourceBranches.map((b) => <SelectItem key={b.id} value={b.id}>{b.code} — {b.name}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1.5"><Label>To branch</Label>
            <Select value={dest} onValueChange={setDest}>
              <SelectTrigger><SelectValue placeholder="Receiving branch" /></SelectTrigger>
              <SelectContent>{allBranches.filter((b) => b.id !== source).map((b) => <SelectItem key={b.id} value={b.id}>{b.code} — {b.name}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1.5"><Label>Dispatch date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Expected arrival</Label><Input type="datetime-local" value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
        </div>
        <div className="space-y-1.5"><Label>Reference</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-5">
        <h3 className="font-semibold">Goods</h3>
        <StockLineEditor products={products} lines={lines} setLines={setLines} showCost={false} qtyLabel="Qty to send" />
      </CardContent></Card>

      <Card><CardContent className="space-y-4 p-5">
        <h3 className="font-semibold">Truck and driver</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5"><Label>Truck registration *</Label><Input value={tp.vehicleRegistration} onChange={setT("vehicleRegistration")} placeholder="e.g. T 123 ABC" /></div>
          <div className="space-y-1.5"><Label>Trailer registration</Label><Input value={tp.trailerRegistration} onChange={setT("trailerRegistration")} /></div>
          <div />
          <div className="space-y-1.5"><Label>Driver name *</Label><Input value={tp.driverName} onChange={setT("driverName")} /></div>
          <div className="space-y-1.5"><Label>Driver phone</Label><Input type="tel" value={tp.driverPhone} onChange={setT("driverPhone")} placeholder="e.g. 0712 345 678" /></div>
          {canLicence
            ? <div className="space-y-1.5"><Label>Driving licence number</Label><Input value={tp.driverLicence} onChange={setT("driverLicence")} /></div>
            : <p className="text-xs text-muted-foreground sm:pt-7">The licence number is recorded by users allowed to see licences.</p>}
          <div className="space-y-1.5"><Label>Transporter company</Label><Input value={tp.transporterName} onChange={setT("transporterName")} /></div>
          <div className="space-y-1.5"><Label>Transporter phone / contact</Label><Input value={tp.transporterContact} onChange={setT("transporterContact")} /></div>
        </div>
        <p className="text-xs text-muted-foreground">Licence photos, loading photos and weighbridge tickets can be attached on the transfer after saving.</p>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-5">
        <div>
          <h3 className="font-semibold">Transfer costs</h3>
          <p className="text-xs text-muted-foreground">Loading, transport and any other fees for this move. They are added to the inventory cost of these goods at the receiving branch (shared by weight). Offloading is entered when the goods are received.</p>
        </div>
        {chargesEnabled
          ? <ChargeRows categories={categories} rows={charges} setRows={setCharges} />
          : <p className="rounded-md bg-muted px-3 py-2 text-sm">Transfer costs need <strong>Transfer logistics</strong> switched on (Admin → Feature Flags).</p>}
      </CardContent></Card>

      <Card><CardContent className="space-y-1.5 p-5"><Label>Notes</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></CardContent></Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <Button variant="outline" onClick={() => router.push("/inventory/transfers")} disabled={pending}>Cancel</Button>
        <Button variant="outline" onClick={() => submit(false)} disabled={pending}>Save draft</Button>
        {canDispatch && <Button onClick={() => submit(true)} disabled={pending}>{pending ? "Working..." : "Save & Dispatch"}</Button>}
      </div>
    </div>
  );
}
