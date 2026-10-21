"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { saveShipment, type ShipmentInput } from "@/lib/imports/actions";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProductPicker, type PickerProduct } from "@/components/common/product-picker";

export interface Opt { id: string; label: string }
const INCOTERMS = ["EXW", "FCA", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"];
// Freight / insurance already in the goods price for these terms (editable).
const INCLUDES: Record<string, [boolean, boolean]> = {
  EXW: [false, false], FCA: [false, false], FOB: [false, false], CFR: [true, false], CIF: [true, true],
  CPT: [true, false], CIP: [true, true], DAP: [true, true], DPU: [true, true], DDP: [true, true],
};
interface Line { key: string; product_id: string; weight: string; unit: "mt" | "kg"; quantity: string; shipped: string; value: string; volume: string; batch: string }
const nl = (): Line => ({ key: Math.random().toString(36).slice(2), product_id: "", weight: "", unit: "mt", quantity: "", shipped: "", value: "", volume: "", batch: "" });

export function ShipmentForm({ suppliers, branches, products, currencies, defaultBranchId }: {
  suppliers: Opt[]; branches: Opt[]; products: (PickerProduct & { stock_role: string })[]; currencies: string[]; defaultBranchId: string;
}) {
  const router = useRouter();
  const [f, setF] = React.useState({
    supplierId: "", branchId: defaultBranchId, reference: "", billOfLading: "", vessel: "", containerRefs: "",
    originCountry: "", originPort: "", dischargePort: "Dar es Salaam", incoterm: "CIF", namedPlace: "Dar es Salaam",
    freight: true, insurance: true, currency: "TZS", planningRate: "", ownershipEvent: "bill_of_lading", eta: "", notes: "",
  });
  const [lines, setLines] = React.useState<Line[]>([nl()]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const setLine = (k: string, patch: Partial<Line>) => setLines(lines.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const pMap = new Map(products.map((p) => [p.id, p]));
  const kgOf = (l: Line) => Number(l.weight || 0) * (l.unit === "mt" ? 1000 : 1);
  const totalKg = lines.reduce((s, l) => s + kgOf(l), 0);
  const totalValue = lines.reduce((s, l) => s + Number(l.value || 0), 0);

  async function submit() {
    setError(null);
    const valid = lines.filter((l) => l.product_id && kgOf(l) > 0);
    if (valid.length === 0) { setError("Add at least one product with its weight."); return; }
    const input: ShipmentInput = {
      branchId: f.branchId, supplierId: f.supplierId, reference: f.reference, billOfLading: f.billOfLading, vessel: f.vessel,
      containerRefs: f.containerRefs, originCountry: f.originCountry, originPort: f.originPort, dischargePort: f.dischargePort,
      incoterm: f.incoterm, namedPlace: f.namedPlace, goodsIncludesFreight: f.freight, goodsIncludesInsurance: f.insurance,
      currencyCode: f.currency, planningRate: f.currency === "TZS" ? null : Number(f.planningRate || 0) || null,
      ownershipEvent: f.ownershipEvent as ShipmentInput["ownershipEvent"], eta: f.eta || null, notes: f.notes,
      lines: valid.map((l) => ({
        product_id: l.product_id, net_kg: kgOf(l), quantity: Number(l.quantity || 0) || undefined,
        shipped_kg: null, goods_value: Number(l.value || 0), volume_m3: Number(l.volume || 0) || null, batch_reference: l.batch,
      })),
    };
    setPending(true);
    const res = await saveShipment(input);
    setPending(false);
    if (res.ok && res.id) { toast.success("Shipment saved."); router.push(`/imports/${res.id}`); }
    else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
        <div className="space-y-1.5"><Label>Supplier *</Label>
          <Select value={f.supplierId} onValueChange={(v) => set({ supplierId: v })}><SelectTrigger><SelectValue placeholder="Goods supplier" /></SelectTrigger>
            <SelectContent>{suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label>Destination warehouse *</Label>
          <Select value={f.branchId} onValueChange={(v) => set({ branchId: v })}><SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label>Shipment reference</Label><Input value={f.reference} onChange={(e) => set({ reference: e.target.value })} placeholder="PO / contract no." /></div>
        <div className="space-y-1.5"><Label>Delivery terms *</Label>
          <Select value={f.incoterm} onValueChange={(v) => set({ incoterm: v, freight: INCLUDES[v][0], insurance: INCLUDES[v][1] })}><SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{INCOTERMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label>Named place *</Label><Input value={f.namedPlace} onChange={(e) => set({ namedPlace: e.target.value })} placeholder="e.g. Dar es Salaam" /></div>
        <div className="space-y-1.5"><Label>Ownership / control passes at</Label>
          <Select value={f.ownershipEvent} onValueChange={(v) => set({ ownershipEvent: v })}><SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="bill_of_lading">Bill of lading (shipment)</SelectItem>
              <SelectItem value="arrival">Arrival at port</SelectItem>
              <SelectItem value="receipt">Receipt at warehouse</SelectItem>
            </SelectContent></Select></div>
        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2"><Label>Goods price includes freight</Label><Switch checked={f.freight} onCheckedChange={(v) => set({ freight: v })} /></div>
        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2"><Label>Goods price includes insurance</Label><Switch checked={f.insurance} onCheckedChange={(v) => set({ insurance: v })} /></div>
        <div className="space-y-1.5"><Label>Invoice currency</Label>
          <Select value={f.currency} onValueChange={(v) => set({ currency: v })}><SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="TZS">TZS</SelectItem>{currencies.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select></div>
        {f.currency !== "TZS" && (
          <div className="space-y-1.5"><Label>Planning rate (TZS per 1 {f.currency})</Label>
            <Input type="number" min="0" step="0.000001" value={f.planningRate} onChange={(e) => set({ planningRate: e.target.value })} />
            <p className="text-xs text-muted-foreground">For estimates only — never posted.</p></div>
        )}
        <div className="space-y-1.5"><Label>Bill of lading</Label><Input value={f.billOfLading} onChange={(e) => set({ billOfLading: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>Vessel</Label><Input value={f.vessel} onChange={(e) => set({ vessel: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>Containers</Label><Input value={f.containerRefs} onChange={(e) => set({ containerRefs: e.target.value })} placeholder="Bulk vessel: leave blank" /></div>
        <div className="space-y-1.5"><Label>Origin country</Label><Input value={f.originCountry} onChange={(e) => set({ originCountry: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>Port of loading</Label><Input value={f.originPort} onChange={(e) => set({ originPort: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>Port of discharge</Label><Input value={f.dischargePort} onChange={(e) => set({ dischargePort: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>ETA</Label><Input type="date" value={f.eta} onChange={(e) => set({ eta: e.target.value })} /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Notes</Label><Textarea value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></div>
      </CardContent></Card>

      <Card><CardContent className="p-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr>
              <th className="px-2 py-2 text-left">Product</th><th className="px-2 py-2 text-right">Net weight</th><th className="px-2 py-2 text-right">Units (non-bulk)</th>
              <th className="px-2 py-2 text-right">Goods value ({f.currency})</th><th className="px-2 py-2 text-right">Volume m³</th><th className="px-2 py-2 text-left">Batch</th><th />
            </tr></thead>
            <tbody>
              {lines.map((l) => {
                const bulk = pMap.get(l.product_id)?.stock_role === "bulk";
                return (
                  <tr key={l.key} className="border-t border-border align-top">
                    <td className="min-w-[260px] px-1 py-1"><ProductPicker products={products} value={l.product_id} onChange={(v) => setLine(l.key, { product_id: v })} /></td>
                    <td className="px-1 py-1"><div className="flex gap-1">
                      <Input className="h-8 w-28 text-right tabular-nums" type="number" min="0" step="0.0001" value={l.weight} onChange={(e) => setLine(l.key, { weight: e.target.value })} />
                      <Select value={l.unit} onValueChange={(v) => setLine(l.key, { unit: v as "mt" | "kg" })}><SelectTrigger className="h-8 w-20"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="mt">MT</SelectItem><SelectItem value="kg">kg</SelectItem></SelectContent></Select></div></td>
                    <td className="px-1 py-1"><Input className="h-8 w-24 text-right tabular-nums" type="number" min="0" step="1" disabled={bulk} placeholder={bulk ? "kg" : ""} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} /></td>
                    <td className="px-1 py-1"><Input className="h-8 w-36 text-right tabular-nums" type="number" min="0" step="0.01" value={l.value} onChange={(e) => setLine(l.key, { value: e.target.value })} /></td>
                    <td className="px-1 py-1"><Input className="h-8 w-24 text-right tabular-nums" type="number" min="0" step="0.0001" value={l.volume} onChange={(e) => setLine(l.key, { volume: e.target.value })} /></td>
                    <td className="px-1 py-1"><Input className="h-8 w-28" value={l.batch} onChange={(e) => setLine(l.key, { batch: e.target.value })} /></td>
                    <td className="px-1 py-1"><button type="button" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setLines([...lines, nl()])}><Plus className="h-4 w-4" /> Add line</Button>
      </CardContent></Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Total <span className="font-semibold text-foreground tabular-nums">{(totalKg / 1000).toLocaleString()} MT</span> ({totalKg.toLocaleString()} kg) · goods {f.currency} <span className="tabular-nums">{formatMoney(totalValue)}</span></p>
        <div className="flex items-center gap-2">
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button onClick={submit} disabled={pending}>{pending ? "Saving..." : "Save shipment"}</Button>
        </div>
      </div>
    </div>
  );
}
