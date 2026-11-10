"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Gift, Plus, Trash2 } from "lucide-react";
import { saveSalesRequest, submitSalesRequest, type SalesRequestInput } from "@/lib/sales/fulfilment-actions";
import { uploadAttachmentFile } from "@/lib/attachments/client-upload";
import { calcLine, round2 } from "@/lib/sales/calc";
import { earnedFreeGoods, type PromotionRule } from "@/lib/sales/promotions";
import { formatMoney, formatDate, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProductPicker } from "@/components/common/product-picker";
import type { ProductOpt, TaxOpt, AccountOpt, CustomerOpt } from "./sale-form";
import { NewCustomerButton } from "./new-customer";
import { PhoneInput } from "@/components/common/phone-input";

export interface FundOpt { id: string; customer_id: string; document_number: string; reference: string | null; available: number; document_date: string }
export interface RequestInitial {
  requestId: string; customerId: string; contactName: string; contactPhone: string; mode: "collection" | "delivery";
  location: string; destination: string; consigneeName: string; consigneePhone: string; notes: string; orderDiscount: number;
  lines: { product_id: string; quantity: number; unit_price: number; discount: number; tax_code_id: string | null }[];
  payments: { payment_method: string; payment_account_id: string; payment_date: string; amount: number; reference: string }[];
  funds: { receipt_id: string; amount: number }[];
  hasProof: boolean;
}

interface Line { key: string; product_id: string; quantity: string; unit_price: string; discount: string; tax_code_id: string }
interface Pay { key: string; payment_method: string; payment_account_id: string; payment_date: string; amount: string; reference: string }

const NONE = "__none__";
const METHODS: [string, string][] = [["bank_transfer", "Bank transfer"], ["mobile_money", "Mobile money"], ["cash", "Cash"], ["cheque", "Cheque"], ["card", "Card"], ["other", "Other"]];
const k = () => Math.random().toString(36).slice(2);
const nl = (): Line => ({ key: k(), product_id: "", quantity: "1", unit_price: "", discount: "0", tax_code_id: NONE });

export function RequestForm({
  branchId, products, taxCodes, accounts, customers, onHand, reserved, funds, promotions = [], rewards = {}, initial,
}: {
  branchId: string; products: ProductOpt[]; taxCodes: TaxOpt[]; accounts: AccountOpt[]; customers: CustomerOpt[];
  onHand: Record<string, number>; reserved: Record<string, number>; funds: FundOpt[];
  promotions?: PromotionRule[]; rewards?: Record<string, { product_id: string; quantity: number; label: string }[]>;
  initial?: RequestInitial;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = React.useState(initial?.customerId ?? "");
  const [added, setAdded] = React.useState<CustomerOpt[]>([]);
  const allCustomers = [...customers, ...added];
  const [contactName, setContactName] = React.useState(initial?.contactName ?? "");
  const [contactPhone, setContactPhone] = React.useState(initial?.contactPhone ?? "");
  const [mode, setMode] = React.useState<"collection" | "delivery">(initial?.mode ?? "collection");
  const [location, setLocation] = React.useState(initial?.location ?? "");
  const [destination, setDestination] = React.useState(initial?.destination ?? "");
  const [consigneeName, setConsigneeName] = React.useState(initial?.consigneeName ?? "");
  const [consigneePhone, setConsigneePhone] = React.useState(initial?.consigneePhone ?? "");
  const [notes, setNotes] = React.useState(initial?.notes ?? "");
  const [orderDiscount, setOrderDiscount] = React.useState(String(initial?.orderDiscount ?? 0));
  const [lines, setLines] = React.useState<Line[]>(initial?.lines.length
    ? initial.lines.map((l) => ({ key: k(), product_id: l.product_id, quantity: String(l.quantity), unit_price: String(l.unit_price), discount: String(l.discount), tax_code_id: l.tax_code_id ?? NONE }))
    : [nl()]);
  const [pays, setPays] = React.useState<Pay[]>((initial?.payments ?? []).map((p) => ({ key: k(), ...p, amount: String(p.amount) })));
  const [useFunds, setUseFunds] = React.useState<Record<string, string>>(Object.fromEntries((initial?.funds ?? []).map((f) => [f.receipt_id, String(f.amount)])));
  // Files to attach: picked in one or several goes; each is proof of payment or another document.
  const [files, setFiles] = React.useState<{ key: string; file: File; category: "proof_of_payment" | "other" }[]>([]);
  const proofs = files.filter((f) => f.category === "proof_of_payment");
  const addFiles = (list: FileList | null) => {
    const picked = Array.from(list ?? []).filter((f) => !files.some((x) => x.file.name === f.name && x.file.size === f.size));
    setFiles([...files, ...picked.map((file) => ({ key: k(), file, category: "proof_of_payment" as const }))]);
  };
  const [redeem, setRedeem] = React.useState(true);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const taxMap = new Map(taxCodes.map((t) => [t.id, t]));
  const prodMap = new Map(products.map((p) => [p.id, p]));
  const setLine = (key: string, patch: Partial<Line>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const setPay = (key: string, patch: Partial<Pay>) => setPays(pays.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const calc = lines.map((l) => {
    const tc = l.tax_code_id !== NONE ? taxMap.get(l.tax_code_id) : null;
    return calcLine({ quantity: Number(l.quantity || 0), unitPrice: Number(l.unit_price || 0), discount: Number(l.discount || 0), taxRate: tc ? tc.rate : 0, taxInclusive: tc ? tc.is_inclusive : false });
  });
  const disc = Number(orderDiscount || 0);
  const linesBase = round2(calc.reduce((s, c) => s + c.base, 0));
  // Order discount reduces each line's base pro rata (the server distributes it exactly the same way).
  const factor = linesBase > 0 ? Math.max(0, (linesBase - disc) / linesBase) : 1;
  const totals = calc.reduce((t, c) => {
    const tc = lines[calc.indexOf(c)].tax_code_id;
    const rate = tc !== NONE ? taxMap.get(tc)?.rate ?? 0 : 0;
    const incl = tc !== NONE ? taxMap.get(tc)?.is_inclusive ?? false : false;
    const base = round2(c.base * factor);
    const net = incl && rate > 0 ? round2(base / (1 + rate / 100)) : base;
    const tax = incl && rate > 0 ? round2(base - net) : round2(base * rate / 100);
    return { sub: t.sub + c.gross, net: t.net + net, tax: t.tax + tax, grand: t.grand + net + tax };
  }, { sub: 0, net: 0, tax: 0, grand: 0 });
  const grand = round2(totals.grand);

  const custFunds = funds.filter((f) => f.customer_id === customerId);
  const newPaid = round2(pays.reduce((s, p) => s + Number(p.amount || 0), 0));
  const fundsUsed = round2(custFunds.reduce((s, f) => s + Number(useFunds[f.id] || 0), 0));
  const covered = round2(newPaid + fundsUsed);

  const walkIn = !!customerId && allCustomers.find((c) => c.id === customerId)?.is_protected === true;
  const bought = new Map<string, number>();
  for (const l of lines) if (l.product_id && Number(l.quantity) > 0) bought.set(l.product_id, (bought.get(l.product_id) ?? 0) + Number(l.quantity));
  const freeNow = earnedFreeGoods(promotions.filter((r) => r.reward_timing === "current_order"), bought, todayISO(), walkIn || !customerId);
  const freeNext = earnedFreeGoods(promotions.filter((r) => r.reward_timing === "next_order"), bought, todayISO(), walkIn || !customerId);
  const waiting = walkIn || !customerId ? [] : (rewards[customerId] ?? []);

  const requested = new Map(bought);
  for (const f of freeNow) requested.set(f.promotion.product_id, (requested.get(f.promotion.product_id) ?? 0) + f.quantity);
  if (redeem) for (const w of waiting) requested.set(w.product_id, (requested.get(w.product_id) ?? 0) + w.quantity);
  const availableOf = (pid: string) => round2((onHand[pid] ?? 0) - (reserved[pid] ?? 0));
  const shortOf = (pid: string) => prodMap.get(pid)?.track_inventory !== false && (requested.get(pid) ?? 0) > availableOf(pid) + 0.00005;

  const valid = lines.filter((l) => l.product_id && Number(l.quantity) > 0);
  const blockers: string[] = [];
  if (!customerId) blockers.push("Choose a customer.");
  if (valid.length === 0) blockers.push("Add at least one product.");
  const short = [...requested.keys()].filter(shortOf);
  if (short.length) blockers.push(`Not enough available stock for ${short.map((p) => prodMap.get(p)?.name ?? "a product").join(", ")}.`);
  if (mode === "delivery" && !destination.trim()) blockers.push("Enter the delivery destination.");
  if (pays.some((p) => !p.payment_account_id || !(Number(p.amount) > 0) || !p.reference.trim() || !p.payment_date)) blockers.push("Complete each payment: account, date, amount and transaction reference.");
  if (custFunds.some((f) => Number(useFunds[f.id] || 0) > f.available + 0.001)) blockers.push("A selected fund is more than its available balance.");
  if (valid.length && covered + 0.001 < grand) blockers.push(`Payments cover ${formatMoney(covered)} of ${formatMoney(grand)}. The full sale value must be paid before approval.`);
  if (pays.length > 0 && proofs.length === 0 && !initial?.hasProof) blockers.push("Attach proof of payment.");
  if (disc > linesBase + 0.001) blockers.push("The order discount is more than the order value.");

  async function save(submit: boolean) {
    setError(null);
    if (submit && blockers.length) { setError(blockers[0]); return; }
    const big = files.find((f) => f.file.size > 20 * 1024 * 1024);
    if (big) { setError(`${big.file.name} is larger than 20 MB.`); return; }
    const input: SalesRequestInput = {
      requestId: initial?.requestId, branchId, customerId, contactName, contactPhone, fulfilmentMode: mode, fulfilmentLocation: location,
      destination, consigneeName, consigneePhone, notes, orderDiscount: disc, redeemRewards: redeem,
      lines: valid.map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit_price: Number(l.unit_price || 0), discount: Number(l.discount || 0),
        tax_code_id: l.tax_code_id === NONE ? null : l.tax_code_id })),
      payments: pays.map((p) => ({ payment_method: p.payment_method, payment_account_id: p.payment_account_id, payment_date: p.payment_date, amount: Number(p.amount), reference: p.reference })),
      funds: custFunds.filter((f) => Number(useFunds[f.id] || 0) > 0).map((f) => ({ receipt_id: f.id, amount: Number(useFunds[f.id]) })),
    };
    setPending(true);
    const res = await saveSalesRequest(input);
    if (!res.ok || !res.id) { setError(res.error ?? "Failed."); setPending(false); return; }
    for (const { file, category } of files) {
      const up = await uploadAttachmentFile({ ownerType: "sales_request", ownerId: res.id, category, file });
      if (!up.ok) { toast.error(`Request saved, but ${file.name} did not upload: ${up.error}`); router.push(`/sales/requests/${res.id}`); return; }
    }
    if (submit) {
      const s = await submitSalesRequest(res.id);
      if (!s.ok) { toast.error(`Saved as a draft: ${s.error ?? "it could not be submitted."}`); router.push(`/sales/requests/${res.id}`); return; }
      toast.success("Submitted to the manager for approval.");
    } else toast.success("Draft saved.");
    router.push(`/sales/requests/${res.id}`);
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <div className="min-w-0 space-y-4">
        <Card>
          <CardContent className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 sm:p-5">
            <div className="space-y-1.5 sm:col-span-2">
              <div className="flex items-center justify-between gap-2"><Label>Customer</Label>
                <NewCustomerButton branchId={branchId} existing={allCustomers}
                  onCreated={(c) => { setAdded([...added, { ...c, is_protected: false }]); setCustomerId(c.id); }} /></div>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                <SelectContent>{allCustomers.filter((c) => !c.is_protected).map((c) => <SelectItem key={c.id} value={c.id}>{c.code} — {c.name}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-1.5"><Label>Contact person</Label><Input value={contactName} onChange={(e) => setContactName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Contact phone</Label><PhoneInput value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Fulfilment</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as "collection" | "delivery")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="collection">Customer collects</SelectItem><SelectItem value="delivery">We deliver</SelectItem></SelectContent>
              </Select></div>
            <div className="space-y-1.5"><Label>Loading point / store</Label><Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Main warehouse" /></div>
            {mode === "delivery" && (
              <>
                <div className="space-y-1.5 sm:col-span-2"><Label>Destination <span className="text-destructive">*</span></Label><Input value={destination} onChange={(e) => setDestination(e.target.value)} /></div>
                <div className="space-y-1.5"><Label>Consignee</Label><Input value={consigneeName} onChange={(e) => setConsigneeName(e.target.value)} /></div>
                <div className="space-y-1.5"><Label>Consignee phone</Label><PhoneInput value={consigneePhone} onChange={(e) => setConsigneePhone(e.target.value)} /></div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-3">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 text-left">Product</th>
                    <th className="px-2 py-2 text-right" title="On hand minus stock reserved for other approved orders">Available</th>
                    <th className="px-2 py-2 text-right">Qty</th>
                    <th className="px-2 py-2 text-right">Price</th>
                    <th className="px-2 py-2 text-right">Disc</th>
                    <th className="px-2 py-2 text-left">Tax</th>
                    <th className="px-2 py-2 text-right">Total</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const p = prodMap.get(l.product_id);
                    const isShort = l.product_id ? shortOf(l.product_id) : false;
                    return (
                      <tr key={l.key} className="border-t border-border align-top">
                        <td className="min-w-[240px] px-1 py-1">
                          <ProductPicker products={products} value={l.product_id} available={onHand}
                            onChange={(v) => { const q = prodMap.get(v); setLine(l.key, { product_id: v, unit_price: q ? String(q.selling_price) : "", tax_code_id: q?.tax_code_id ?? NONE }); }} />
                          {isShort && <p className="px-1 pt-0.5 text-xs font-medium text-destructive">Only {availableOf(l.product_id)} available</p>}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-right text-xs tabular-nums text-muted-foreground">
                          {!p ? "—" : p.track_inventory ? <>{availableOf(p.id)}{(reserved[p.id] ?? 0) > 0 && <span className="block">({onHand[p.id] ?? 0} on hand)</span>}</> : "n/a"}
                        </td>
                        <td className="px-1 py-1"><Input className={`h-8 w-20 text-right tabular-nums ${isShort ? "border-destructive" : ""}`} type="number" min="0" step="0.0001" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} /></td>
                        <td className="px-1 py-1"><Input className="h-8 w-28 text-right tabular-nums" type="number" min="0" step="0.01" value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} /></td>
                        <td className="px-1 py-1"><Input className="h-8 w-24 text-right tabular-nums" type="number" min="0" step="0.01" value={l.discount} onChange={(e) => setLine(l.key, { discount: e.target.value })} /></td>
                        <td className="min-w-[120px] px-1 py-1">
                          <Select value={l.tax_code_id} onValueChange={(v) => setLine(l.key, { tax_code_id: v })}>
                            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value={NONE}>No tax</SelectItem>{taxCodes.map((t) => <SelectItem key={t.id} value={t.id}>{t.name} ({t.rate}%)</SelectItem>)}</SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{formatMoney(calc[i].lineTotal)}</td>
                        <td className="px-1 py-1 text-center">
                          <button type="button" aria-label="Remove line" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, nl()])}><Plus className="h-4 w-4" /> Add product</Button>
              <div className="flex items-center gap-2 text-sm"><Label htmlFor="od">Order discount</Label>
                <Input id="od" className="h-8 w-32 text-right tabular-nums" type="number" min="0" step="0.01" value={orderDiscount} onChange={(e) => setOrderDiscount(e.target.value)} /></div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Transport or other charges: add them as products that do not track stock. They are invoiced with the trucks in proportion to the goods.</p>
          </CardContent>
        </Card>

        {(freeNow.length > 0 || waiting.length > 0 || freeNext.length > 0) && (
          <Card className="border-success/40">
            <CardContent className="space-y-2 p-4 text-sm sm:p-5">
              <p className="flex items-center gap-2 font-medium"><Gift className="h-4 w-4 text-success" /> Promotion free goods</p>
              {freeNow.map((f) => <p key={f.promotion.id}>{f.quantity} × {prodMap.get(f.promotion.product_id)?.name ?? "product"} free in this order <span className="text-muted-foreground">({f.promotion.name})</span></p>)}
              {waiting.length > 0 && (
                <label className="flex cursor-pointer items-start gap-2 rounded-md bg-muted/50 p-2.5">
                  <Checkbox className="mt-0.5" checked={redeem} onCheckedChange={(v) => setRedeem(v === true)} />
                  <span>Give the free goods earned in earlier orders: <span className="block text-muted-foreground">{waiting.map((w) => `${w.quantity} × ${prodMap.get(w.product_id)?.name ?? "product"} (${w.label})`).join("; ")}</span></span>
                </label>
              )}
              {freeNext.map((f) => <p key={f.promotion.id} className="text-muted-foreground">This order earns {f.quantity} × {prodMap.get(f.promotion.product_id)?.name ?? "product"} free on the next order ({f.promotion.name}).</p>)}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="space-y-3 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <div><Label>Payments received</Label><p className="text-xs text-muted-foreground">The manager verifies each payment against the bank or collection record before approving.</p></div>
              <Button type="button" variant="outline" size="sm" onClick={() => setPays([...pays, { key: k(), payment_method: "bank_transfer", payment_account_id: "", payment_date: todayISO(), amount: "", reference: "" }])}>
                <Plus className="h-4 w-4" /> Add payment
              </Button>
            </div>
            {pays.map((p) => (
              <div key={p.key} className="grid grid-cols-2 gap-2 rounded-md border border-border p-2 sm:grid-cols-[130px_1fr_130px_120px_1fr_auto]">
                <Select value={p.payment_method} onValueChange={(v) => setPay(p.key, { payment_method: v })}>
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>{METHODS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={p.payment_account_id} onValueChange={(v) => setPay(p.key, { payment_account_id: v })}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="Received into" /></SelectTrigger>
                  <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
                </Select>
                <Input className="h-8" type="date" value={p.payment_date} onChange={(e) => setPay(p.key, { payment_date: e.target.value })} />
                <Input className="h-8 text-right tabular-nums" type="number" min="0" step="0.01" placeholder="Amount" value={p.amount} onChange={(e) => setPay(p.key, { amount: e.target.value })} />
                <Input className="h-8" placeholder="Transaction reference" value={p.reference} onChange={(e) => setPay(p.key, { reference: e.target.value })} />
                <button type="button" aria-label="Remove payment" onClick={() => setPays(pays.filter((x) => x.key !== p.key))} className="justify-self-end p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
            {custFunds.length > 0 && (
              <div className="space-y-2 rounded-md bg-muted/40 p-3">
                <p className="text-sm font-medium">Customer’s verified funds available</p>
                {custFunds.map((f) => (
                  <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>{f.document_number} · {f.reference ?? "—"} · {formatDate(f.document_date)} <span className="text-muted-foreground">({formatMoney(f.available)} available)</span></span>
                    <Input className="h-8 w-36 text-right tabular-nums" type="number" min="0" step="0.01" placeholder="Use amount" value={useFunds[f.id] ?? ""}
                      onChange={(e) => setUseFunds({ ...useFunds, [f.id]: e.target.value })} />
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-1.5 rounded-md border border-dashed border-border p-3">
              <Label htmlFor="proof">Proof of payment and documents {pays.length > 0 && !initial?.hasProof && <span className="text-destructive">*</span>}</Label>
              <Input id="proof" type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp"
                onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              {files.length > 0 && (
                <ul className="space-y-1.5 pt-1">
                  {files.map((f) => (
                    <li key={f.key} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{f.file.name} <span className="text-xs text-muted-foreground">({(f.file.size / 1024 / 1024).toFixed(1)} MB)</span></span>
                      <Select value={f.category} onValueChange={(v) => setFiles(files.map((x) => (x.key === f.key ? { ...x, category: v as typeof f.category } : x)))}>
                        <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="proof_of_payment">Proof of payment</SelectItem><SelectItem value="other">Other document</SelectItem></SelectContent>
                      </Select>
                      <button type="button" aria-label={`Remove ${f.file.name}`} onClick={() => setFiles(files.filter((x) => x.key !== f.key))} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">{initial?.hasProof ? "Proof already attached; add files only if needed. " : ""}Choose several files at once or add more in several goes. PDF or photos, up to 20 MB each.</p>
            </div>
            <div className="space-y-1.5"><Label>Notes</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></div>
          </CardContent>
        </Card>
      </div>

      <div>
        <Card className="lg:sticky lg:top-20">
          <CardContent className="space-y-2 p-4 text-sm sm:p-5">
            <Row label="Subtotal" value={formatMoney(totals.sub)} />
            <Row label="Net" value={formatMoney(totals.net)} />
            <Row label="Tax" value={formatMoney(totals.tax)} />
            <div className="my-1 border-t border-border" />
            <Row label="Order value" value={formatMoney(grand)} bold />
            <Row label="New payments (to verify)" value={formatMoney(newPaid)} />
            <Row label="Existing verified funds" value={formatMoney(fundsUsed)} />
            <Row label={covered >= grand ? "Excess (stays as customer credit)" : "Still to pay"} value={formatMoney(Math.abs(round2(grand - covered)))} bold />
            {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <div className="flex flex-col gap-2 pt-2">
              <Button onClick={() => save(true)} disabled={pending || blockers.length > 0}>{pending ? "Working..." : "Submit for approval"}</Button>
              <Button variant="outline" onClick={() => save(false)} disabled={pending || !customerId || valid.length === 0}>Save draft</Button>
              {blockers.length > 0 && (
                <div className="pt-1 text-xs text-muted-foreground">
                  <p className="font-medium">Before you can submit:</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                </div>
              )}
              <p className="text-xs text-muted-foreground">Submitting creates no order, invoice or stock movement. The order is created when a manager approves.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={bold ? "font-medium" : "text-muted-foreground"}>{label}</span>
      <span className={`tabular-nums ${bold ? "font-semibold" : ""}`}>{value}</span>
    </div>
  );
}
