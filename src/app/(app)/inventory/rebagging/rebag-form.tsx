"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveRebagOrder, type RebagOrderInput } from "@/lib/rebagging/actions";
import { formatMoney, formatQuantity, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Opt = { id: string; label: string };
export interface RebagOptions {
  branches: Opt[];
  bulkProducts: (Opt & { tolerance: number })[];
  packagedProducts: (Opt & { bulkId: string; kg: number })[];
  materials: Opt[];
  lots: (Opt & { branchId: string; productId: string; kg: number })[];
  stock: { branchId: string; productId: string; qty: number; avg: number }[];
  categories: (Opt & { capitalise: boolean; basis: string })[];
  shipments: Opt[];
}
export interface RebagInitial {
  id: string; status: string; branchId: string; bulkProductId: string; shipmentId: string | null; orderDate: string;
  location: string; operatorName: string; notes: string; returnedKg: number; normalLossKg: number; abnormalLossKg: number;
  bulkLines: { lot_id: string | null; kg: number }[];
  outputs: { id: string; product_id: string; bags: number }[];
  packaging: { product_id: string; quantity: number; damaged_qty: number; qty_per_bag: number | null; target_id: string | null }[];
  charges: { category_id: string; description: string; amount: number; basis: string | null }[];
}

const NONE = "__none__";
const COMMON = "__common__";
const uid = () => Math.random().toString(36).slice(2);
const BASIS_LABEL: Record<string, string> = { quantity: "by bags", weight: "by net kg", value: "by bulk value" };

export function RebagForm({ options, initial, defaultBranchId }: { options: RebagOptions; initial?: RebagInitial; defaultBranchId: string }) {
  const router = useRouter();
  const issued = initial?.status === "issued";
  const [branchId, setBranchId] = React.useState(initial?.branchId ?? defaultBranchId);
  const [bulkId, setBulkId] = React.useState(initial?.bulkProductId ?? "");
  const [shipmentId, setShipmentId] = React.useState(initial?.shipmentId ?? NONE);
  const [date, setDate] = React.useState(initial?.orderDate ?? todayISO());
  const [location, setLocation] = React.useState(initial?.location ?? "");
  const [operator, setOperator] = React.useState(initial?.operatorName ?? "");
  const [notes, setNotes] = React.useState(initial?.notes ?? "");
  const [bulkLines, setBulkLines] = React.useState(initial?.bulkLines.map((l) => ({ key: uid(), lot: l.lot_id ?? NONE, kg: String(l.kg) })) ?? [{ key: uid(), lot: NONE, kg: "" }]);
  const [outputs, setOutputs] = React.useState(initial?.outputs.map((o) => ({ key: o.id, product: o.product_id, bags: String(o.bags) })) ?? [{ key: uid(), product: "", bags: "" }]);
  const [packaging, setPackaging] = React.useState(initial?.packaging.map((p) => ({
    key: uid(), product: p.product_id, qty: String(p.quantity), damaged: String(p.damaged_qty || ""), perBag: p.qty_per_bag ? String(p.qty_per_bag) : "", target: p.target_id ?? COMMON,
  })) ?? []);
  const [charges, setCharges] = React.useState(initial?.charges.map((c) => ({ key: uid(), category: c.category_id, description: c.description, amount: String(c.amount), basis: c.basis ?? "" })) ?? []);
  const [returned, setReturned] = React.useState(String(initial?.returnedKg ?? ""));
  const [normal, setNormal] = React.useState(String(initial?.normalLossKg ?? ""));
  const [abnormal, setAbnormal] = React.useState(String(initial?.abnormalLossKg ?? ""));
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const bulk = options.bulkProducts.find((b) => b.id === bulkId);
  const sizes = options.packagedProducts.filter((p) => p.bulkId === bulkId);
  const lots = options.lots.filter((l) => l.branchId === branchId && l.productId === bulkId);
  const onHand = options.stock.find((s) => s.branchId === branchId && s.productId === bulkId);
  const issuedKg = bulkLines.reduce((a, l) => a + Number(l.kg || 0), 0);
  const packedKg = outputs.reduce((a, o) => a + Number(o.bags || 0) * (sizes.find((s) => s.id === o.product)?.kg ?? 0), 0);
  const totalBags = outputs.reduce((a, o) => a + Number(o.bags || 0), 0);
  const diff = Math.round((issuedKg - packedKg - Number(returned || 0) - Number(normal || 0) - Number(abnormal || 0)) * 1e4) / 1e4;
  const allowedNormal = Math.round(issuedKg * (bulk?.tolerance ?? 0) / 100 * 1e4) / 1e4;
  const outLabel = (key: string) => {
    const o = outputs.find((x) => x.key === key);
    return sizes.find((s) => s.id === o?.product)?.label ?? "output";
  };

  async function submit() {
    setError(null); setPending(true);
    const payload: RebagOrderInput = {
      orderId: initial?.id, branchId, bulkProductId: bulkId, shipmentId: shipmentId === NONE ? null : shipmentId, orderDate: date,
      location, operatorName: operator, notes,
      bulkLines: bulkLines.map((l) => ({ lot_id: l.lot === NONE ? null : l.lot, kg: Number(l.kg || 0) })),
      outputs: outputs.filter((o) => o.product).map((o) => ({ key: o.key, product_id: o.product, bags: Number(o.bags || 0) })),
      packaging: packaging.filter((p) => p.product).map((p) => ({ product_id: p.product, quantity: Number(p.qty || 0), damaged_qty: Number(p.damaged || 0),
        qty_per_bag: p.perBag ? Number(p.perBag) : null, target_key: p.target === COMMON ? null : p.target })),
      charges: charges.filter((c) => c.category).map((c) => ({ category_id: c.category, description: c.description, amount: Number(c.amount || 0), basis: c.basis || null })),
      returnedKg: Number(returned || 0), normalLossKg: Number(normal || 0), abnormalLossKg: Number(abnormal || 0),
    };
    const res = await saveRebagOrder(payload);
    setPending(false);
    if (res.ok) { toast.success("Rebagging order saved."); router.push(`/inventory/rebagging/${res.id}`); } else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-4">
        <div className="space-y-1.5"><Label>Branch *</Label>
          <Select value={branchId} onValueChange={setBranchId} disabled={issued}><SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{options.branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Bulk product *</Label>
          <Select value={bulkId} onValueChange={(v) => { setBulkId(v); setOutputs([{ key: uid(), product: "", bags: "" }]); setBulkLines([{ key: uid(), lot: NONE, kg: "" }]); }} disabled={issued}>
            <SelectTrigger><SelectValue placeholder="Select bulk product" /></SelectTrigger>
            <SelectContent>{options.bulkProducts.map((b) => <SelectItem key={b.id} value={b.id}>{b.label}</SelectItem>)}</SelectContent></Select>
          {bulk && <p className="text-xs text-muted-foreground">On hand {formatQuantity(onHand?.qty ?? 0)} kg at {formatMoney(onHand?.avg ?? 0)}/kg · normal loss tolerance {bulk.tolerance}%</p>}</div>
        <div className="space-y-1.5"><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Import shipment</Label>
          <Select value={shipmentId} onValueChange={setShipmentId} disabled={issued}><SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={NONE}>None / from the batches</SelectItem>{options.shipments.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1.5"><Label>Location / bay</Label><Input value={location} onChange={(e) => setLocation(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Operator</Label><Input value={operator} onChange={(e) => setOperator(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Notes</Label><Textarea rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-5">
        <h3 className="font-semibold">Bulk issued {issued && <span className="text-xs font-normal text-muted-foreground">(fixed once issued)</span>}</h3>
        {bulkLines.map((l, i) => (
          <div key={l.key} className="flex flex-wrap items-center gap-2">
            <Select value={l.lot} disabled={issued} onValueChange={(v) => setBulkLines(bulkLines.map((x, j) => j === i ? { ...x, lot: v } : x))}>
              <SelectTrigger className="h-8 w-72"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>No batch (untracked stock)</SelectItem>
                {lots.map((lt) => <SelectItem key={lt.id} value={lt.id}>{lt.label} · {formatQuantity(lt.kg)} kg</SelectItem>)}</SelectContent></Select>
            <Input className="h-8 w-36 text-right tabular-nums" type="number" min="0" step="0.0001" placeholder="kg" disabled={issued} value={l.kg}
              onChange={(e) => setBulkLines(bulkLines.map((x, j) => j === i ? { ...x, kg: e.target.value } : x))} />
            {!issued && bulkLines.length > 1 && <Button size="sm" variant="ghost" onClick={() => setBulkLines(bulkLines.filter((_, j) => j !== i))}>Remove</Button>}
          </div>
        ))}
        {!issued && <Button size="sm" variant="outline" onClick={() => setBulkLines([...bulkLines, { key: uid(), lot: NONE, kg: "" }])}>Add batch</Button>}
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-5">
        <h3 className="font-semibold">Packaged output (good bags)</h3>
        {!bulkId ? <p className="text-sm text-muted-foreground">Choose the bulk product first.</p> : sizes.length === 0 ? <p className="text-sm text-muted-foreground">No packaged SKUs are set up for this bulk product (Admin → Products: stock role Packaged, net kg and bulk product).</p> : (
          <>
            {outputs.map((o, i) => (
              <div key={o.key} className="flex flex-wrap items-center gap-2">
                <Select value={o.product} onValueChange={(v) => setOutputs(outputs.map((x, j) => j === i ? { ...x, product: v } : x))}>
                  <SelectTrigger className="h-8 w-72"><SelectValue placeholder="Packaged SKU" /></SelectTrigger>
                  <SelectContent>{sizes.map((s) => <SelectItem key={s.id} value={s.id}>{s.label} ({s.kg} kg)</SelectItem>)}</SelectContent></Select>
                <Input className="h-8 w-28 text-right tabular-nums" type="number" min="1" step="1" placeholder="bags" value={o.bags}
                  onChange={(e) => setOutputs(outputs.map((x, j) => j === i ? { ...x, bags: e.target.value } : x))} />
                <span className="text-xs text-muted-foreground tabular-nums">= {formatQuantity(Number(o.bags || 0) * (sizes.find((s) => s.id === o.product)?.kg ?? 0))} kg</span>
                {outputs.length > 1 && <Button size="sm" variant="ghost" onClick={() => { setOutputs(outputs.filter((_, j) => j !== i)); setPackaging(packaging.map((p) => p.target === o.key ? { ...p, target: COMMON } : p)); }}>Remove</Button>}
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => setOutputs([...outputs, { key: uid(), product: "", bags: "" }])}>Add size</Button>
          </>
        )}
      </CardContent></Card>

      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-4">
        <div className="space-y-1.5"><Label>Unused bulk returned (kg)</Label><Input type="number" min="0" step="0.0001" value={returned} onChange={(e) => setReturned(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Normal loss (kg)</Label><Input type="number" min="0" step="0.0001" value={normal} onChange={(e) => setNormal(e.target.value)} />
          <p className="text-xs text-muted-foreground">Up to {formatQuantity(allowedNormal)} kg ({bulk?.tolerance ?? 0}%) — absorbed into the bags.</p></div>
        <div className="space-y-1.5"><Label>Abnormal loss (kg)</Label><Input type="number" min="0" step="0.0001" value={abnormal} onChange={(e) => setAbnormal(e.target.value)} />
          <p className="text-xs text-muted-foreground">Needs an approver; expensed, not added to bag cost.</p></div>
        <div className="space-y-1 rounded-md bg-muted/50 p-3 text-sm tabular-nums">
          <div className="flex justify-between"><span>Issued</span><span>{formatQuantity(issuedKg)} kg</span></div>
          <div className="flex justify-between"><span>Packed ({formatQuantity(totalBags)} bags)</span><span>{formatQuantity(packedKg)} kg</span></div>
          <div className={`flex justify-between font-semibold ${diff === 0 ? "text-success" : "text-destructive"}`}><span>Unexplained</span><span>{formatQuantity(diff)} kg</span></div>
        </div>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-5">
        <h3 className="font-semibold">Packaging materials actually used</h3>
        <p className="text-xs text-muted-foreground">Bags, liners and labels go to their own size; thread or other common materials are shared by bag count. Used = good + damaged; with &quot;per bag&quot; set, good must equal the bags packed.</p>
        {packaging.map((p, i) => (
          <div key={p.key} className="flex flex-wrap items-center gap-2">
            <Select value={p.product} onValueChange={(v) => setPackaging(packaging.map((x, j) => j === i ? { ...x, product: v } : x))}>
              <SelectTrigger className="h-8 w-60"><SelectValue placeholder="Material" /></SelectTrigger>
              <SelectContent>{options.materials.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}</SelectContent></Select>
            <Select value={p.target} onValueChange={(v) => setPackaging(packaging.map((x, j) => j === i ? { ...x, target: v } : x))}>
              <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={COMMON}>Common to all sizes</SelectItem>
                {outputs.filter((o) => o.product).map((o) => <SelectItem key={o.key} value={o.key}>For {outLabel(o.key)}</SelectItem>)}</SelectContent></Select>
            <Input className="h-8 w-24 text-right" type="number" min="0" step="0.0001" placeholder="used" value={p.qty} onChange={(e) => setPackaging(packaging.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} />
            <Input className="h-8 w-24 text-right" type="number" min="0" step="0.0001" placeholder="damaged" value={p.damaged} onChange={(e) => setPackaging(packaging.map((x, j) => j === i ? { ...x, damaged: e.target.value } : x))} />
            <Input className="h-8 w-24 text-right" type="number" min="0" step="0.0001" placeholder="per bag" value={p.perBag} onChange={(e) => setPackaging(packaging.map((x, j) => j === i ? { ...x, perBag: e.target.value } : x))} />
            <Button size="sm" variant="ghost" onClick={() => setPackaging(packaging.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button size="sm" variant="outline" onClick={() => setPackaging([...packaging, { key: uid(), product: "", qty: "", damaged: "", perBag: "1", target: COMMON }])}>Add material</Button>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-5">
        <h3 className="font-semibold">Conversion charges (labour / contractor)</h3>
        <p className="text-xs text-muted-foreground">Accrued at completion; the contractor&apos;s invoice is later posted against the charge under Importation → Cost Invoices, and only the difference changes cost.</p>
        {charges.map((c, i) => {
          const cat = options.categories.find((x) => x.id === c.category);
          return (
            <div key={c.key} className="flex flex-wrap items-center gap-2">
              <Select value={c.category} onValueChange={(v) => setCharges(charges.map((x, j) => j === i ? { ...x, category: v, basis: "" } : x))}>
                <SelectTrigger className="h-8 w-60"><SelectValue placeholder="Category" /></SelectTrigger>
                <SelectContent>{options.categories.map((x) => <SelectItem key={x.id} value={x.id}>{x.label}</SelectItem>)}</SelectContent></Select>
              <Input className="h-8 w-48" placeholder="Description" value={c.description} onChange={(e) => setCharges(charges.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
              <Input className="h-8 w-32 text-right" type="number" min="0" step="0.01" placeholder="TZS" value={c.amount} onChange={(e) => setCharges(charges.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
              {cat?.capitalise ? (
                <Select value={c.basis || cat.basis} onValueChange={(v) => setCharges(charges.map((x, j) => j === i ? { ...x, basis: v } : x))}>
                  <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>{["quantity", "weight", "value"].map((b) => <SelectItem key={b} value={b}>{BASIS_LABEL[b]}</SelectItem>)}</SelectContent></Select>
              ) : cat && <span className="text-xs text-muted-foreground">Expensed</span>}
              <Button size="sm" variant="ghost" onClick={() => setCharges(charges.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          );
        })}
        <Button size="sm" variant="outline" onClick={() => setCharges([...charges, { key: uid(), category: options.categories[0]?.id ?? "", description: "", amount: "", basis: "" }])}>Add charge</Button>
      </CardContent></Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <Button onClick={submit} disabled={pending || !bulkId || !branchId}>{pending ? "Saving..." : initial ? "Save changes" : "Save draft"}</Button>
      </div>
    </div>
  );
}
