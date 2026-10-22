"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { suggestPrice, validatePricing, netOfVat, actualMargins, type PricingMode } from "@/lib/pricing/calc";
import { approveSellingPrice } from "@/lib/pricing/actions";
import { formatMoney, formatQuantity } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-price`);

export function PricingCalculator({ productId, branchId, canApprove, product, accountingCost, suggestedOverhead, overheadPerKg, tax }: {
  productId: string; branchId: string; canApprove: boolean;
  product: { sku: string; name: string; kgPerUnit: number | null; currentPrice: number; qty: number };
  accountingCost: number; suggestedOverhead: number; overheadPerKg: number; tax: { name: string; rate: number; inclusive: boolean };
}) {
  const router = useRouter();
  const [overhead, setOverhead] = React.useState(String(suggestedOverhead));
  const [mode, setMode] = React.useState<PricingMode>("margin");
  const [rate, setRate] = React.useState("20");
  const [price, setPrice] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [requestId, setRequestId] = React.useState(rid);
  const input = { accountingCost, commercialOverhead: Number(overhead || 0), mode, ratePct: Number(rate || 0), taxRatePct: tax.rate, taxInclusive: tax.inclusive };
  const err = validatePricing(input);
  const s = err ? null : suggestPrice(input);
  const current = actualMargins(netOfVat(product.currentPrice, tax.rate, tax.inclusive), accountingCost, input.commercialOverhead);
  const approve = Number(price || s?.sellingPrice || 0);
  const atApprove = actualMargins(netOfVat(approve, tax.rate, tax.inclusive), accountingCost, input.commercialOverhead);
  const row = (label: string, value: React.ReactNode, strong = false) => (
    <div className={`flex justify-between py-1 ${strong ? "font-semibold" : ""}`}><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{value}</span></div>
  );
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card><CardContent className="space-y-1 p-5 text-sm">
        <h3 className="mb-1 font-semibold">{product.sku} — {product.name}</h3>
        {row("On hand", formatQuantity(product.qty))}
        {row("Accounting cost / unit (posted average)", `TZS ${formatMoney(accountingCost)}`, true)}
        {product.kgPerUnit && row("Accounting cost / kg", `TZS ${formatMoney(accountingCost / product.kgPerUnit)}`)}
        {row("Commercial overhead allocation / kg", `TZS ${formatMoney(overheadPerKg)}`)}
        <div className="space-y-1 pt-2"><Label>Commercial overhead / unit (pricing only)</Label>
          <Input type="number" min="0" step="0.01" value={overhead} onChange={(e) => setOverhead(e.target.value)} />
          <p className="text-xs text-muted-foreground">Suggested {formatMoney(suggestedOverhead)} from expensed charges flagged for pricing. Not posted; never added to inventory.</p></div>
        {row("Pricing cost / unit", s ? `TZS ${formatMoney(s.pricingCost)}` : "—", true)}
        {row("Tax code", `${tax.name} · ${tax.rate}% ${tax.inclusive ? "(prices include VAT)" : "(VAT added on top)"}`)}
      </CardContent></Card>
      <Card><CardContent className="space-y-3 p-5 text-sm">
        <h3 className="font-semibold">Suggestion</h3>
        <div className="flex gap-2">
          {(["margin", "markup"] as const).map((m) => (
            <Button key={m} size="sm" variant={mode === m ? "default" : "outline"} onClick={() => setMode(m)}>{m === "margin" ? "Gross margin" : "Markup"}</Button>
          ))}
        </div>
        <div className="space-y-1"><Label>{mode === "margin" ? "Gross margin % (below 100)" : "Markup %"}</Label>
          <Input type="number" min="0" max={mode === "margin" ? 99.99 : undefined} step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
        <p className="text-xs text-muted-foreground">{mode === "margin" ? "Price before tax = pricing cost ÷ (1 − margin)" : "Price before tax = pricing cost × (1 + markup)"}</p>
        {err ? <p className="text-sm text-destructive">{err}</p> : s && <>
          {row("Suggested price before VAT", `TZS ${formatMoney(s.priceExVat)}`, true)}
          {row(`VAT ${tax.rate}%`, `TZS ${formatMoney(s.vat)}`)}
          {row("Suggested price incl. VAT", `TZS ${formatMoney(s.priceInclVat)}`)}
          {row("Selling price to store (tax-code basis)", `TZS ${formatMoney(s.sellingPrice)}`, true)}
          {row(mode === "margin" ? "Implied markup" : "Implied gross margin", `${(mode === "margin" ? s.impliedMarkupPct : s.impliedMarginPct).toFixed(2)}%`)}
        </>}
        <p className="text-xs text-muted-foreground">A suggestion only: the approved selling price changes only when it is saved below.</p>
      </CardContent></Card>
      <Card><CardContent className="space-y-3 p-5 text-sm">
        <h3 className="font-semibold">Approved price and actual margins</h3>
        {row("Current approved selling price", `TZS ${formatMoney(product.currentPrice)}`, true)}
        {row("Gross margin at current price (accounting cost)", `TZS ${formatMoney(current.grossProfit)} · ${current.grossMarginPct.toFixed(1)}%`)}
        {row("Commercial contribution (after overhead)", `TZS ${formatMoney(current.commercialContribution)} · ${current.contributionPct.toFixed(1)}%`)}
        {canApprove ? <>
          <div className="space-y-1 pt-2"><Label>New selling price ({tax.inclusive ? "incl. VAT" : "excl. VAT"})</Label>
            <Input type="number" min="0" step="0.01" placeholder={s ? String(s.sellingPrice) : ""} value={price} onChange={(e) => setPrice(e.target.value)} /></div>
          {row("Gross margin at the new price", `${atApprove.grossMarginPct.toFixed(1)}% · contribution ${atApprove.contributionPct.toFixed(1)}%`)}
          <div className="space-y-1"><Label>Reason</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <Button disabled={!!err || !(approve >= 0)} onClick={() => setOpen(true)}>Save as approved selling price</Button>
          <ConfirmDialog open={open} onOpenChange={setOpen} title={`Change the selling price of ${product.sku} to TZS ${formatMoney(approve)}?`}
            description="This updates the approved price used on new sales (all branches) and is recorded with its costing basis. Stock value and posted documents do not change."
            confirmLabel="Save price" onConfirm={async () => {
              const res = await approveSellingPrice({ productId, price: approve, reason, requestId, basis: { branchId, ...input } });
              if (!res.ok) return res.error ?? "Failed.";
              toast.success("Selling price updated."); setRequestId(rid()); setPrice(""); router.refresh();
            }} />
        </> : <p className="text-xs text-muted-foreground">Only the Owner can change approved selling prices.</p>}
      </CardContent></Card>
    </div>
  );
}
