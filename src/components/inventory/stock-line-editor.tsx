"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export interface ProductOption {
  id: string;
  sku: string;
  name: string;
  selling_price?: number;
  tax_code_id?: string | null;
  track_inventory?: boolean;
}

export interface StockLine {
  key: string;
  product_id: string;
  quantity: string;
  unit_cost: string;
}

export function newLine(): StockLine {
  return { key: Math.random().toString(36).slice(2), product_id: "", quantity: "", unit_cost: "" };
}

export function StockLineEditor({
  products: allProducts,
  lines,
  setLines,
  showCost = true,
  qtyLabel = "Quantity",
  available,
}: {
  products: ProductOption[];
  lines: StockLine[];
  setLines: (l: StockLine[]) => void;
  showCost?: boolean;
  qtyLabel?: string;
  /** Stock on hand by product id. When given, only products with stock can be chosen and quantities are capped. */
  available?: Record<string, number>;
}) {
  const products = available ? allProducts.filter((p) => (available[p.id] ?? 0) > 0) : allProducts;
  function update(key: string, patch: Partial<StockLine>) {
    setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function remove(key: string) {
    setLines(lines.filter((l) => l.key !== key));
  }
  // More requested than on hand, counting every line of the same product.
  const over = (l: StockLine) => {
    if (!available || !l.product_id) return false;
    const total = lines.filter((x) => x.product_id === l.product_id).reduce((s, x) => s + Number(x.quantity || 0), 0);
    return total > (available[l.product_id] ?? 0) + 1e-9;
  };

  const cols = showCost ? "sm:grid-cols-[minmax(0,1fr)_140px_140px_40px]" : "sm:grid-cols-[minmax(0,1fr)_160px_40px]";
  const fmt = (v: number) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 4 });

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border">
        {/* Column headings (wide screens); on phones each line stacks with its own labels. */}
        <div className={`hidden gap-2 bg-muted/50 px-3 py-2 text-sm font-medium sm:grid ${cols}`}>
          <span>Product</span>
          <span className="text-right">{qtyLabel}</span>
          {showCost && <span className="text-right">Unit cost</span>}
          <span />
        </div>
        {lines.map((l) => {
          const onHand = available && l.product_id ? available[l.product_id] ?? 0 : null;
          return (
            <div key={l.key} className={`grid grid-cols-1 gap-2 border-t border-border p-2 first:border-t-0 sm:items-start sm:border-t ${cols}`}>
              <div className="min-w-0">
                <span className="mb-1 block text-xs font-medium text-muted-foreground sm:hidden">Product</span>
                <Select value={l.product_id} onValueChange={(v) => {
                  const p = products.find((x) => x.id === v);
                  update(l.key, { product_id: v, unit_cost: l.unit_cost || (p?.selling_price ? "" : l.unit_cost) });
                }}>
                  <SelectTrigger className="h-auto min-h-9 py-1.5 text-left [&>span]:line-clamp-2 [&>span]:whitespace-normal">
                    <SelectValue placeholder={available && products.length === 0 ? "No products in stock" : "Select product"} />
                  </SelectTrigger>
                  <SelectContent className="max-w-[calc(100vw-2rem)]">
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="whitespace-normal">
                        <span className="block">{p.sku} — {p.name}</span>
                        {available && <span className="block text-xs text-muted-foreground">In stock: {fmt(available[p.id] ?? 0)}</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className={`grid gap-2 sm:contents ${showCost ? "grid-cols-[1fr_1fr_auto]" : "grid-cols-[1fr_auto]"}`}>
                <div>
                  <span className="mb-1 block text-xs font-medium text-muted-foreground sm:hidden">
                    {qtyLabel}{onHand !== null ? ` (in stock ${fmt(onHand)})` : ""}
                  </span>
                  <Input className={`h-9 text-right tabular-nums ${over(l) ? "border-destructive focus-visible:ring-destructive" : ""}`} type="number" inputMode="decimal" step="0.0001" min="0"
                    max={onHand ?? undefined}
                    value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                  {over(l) && <p className="pt-0.5 text-right text-xs font-medium text-destructive">Only {fmt(onHand ?? 0)} in stock</p>}
                </div>
                {showCost && (
                  <div>
                    <span className="mb-1 block text-xs font-medium text-muted-foreground sm:hidden">Unit cost</span>
                    <Input className="h-9 text-right tabular-nums" type="number" inputMode="decimal" step="0.01" min="0"
                      value={l.unit_cost} onChange={(e) => update(l.key, { unit_cost: e.target.value })} />
                  </div>
                )}
                <div className="flex items-end justify-center sm:h-9 sm:items-center">
                  <button type="button" onClick={() => remove(l.key)} aria-label="Remove line"
                    className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {lines.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">No lines yet.</p>
        )}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, newLine()])}>
        <Plus className="h-4 w-4" /> Add line
      </Button>
    </div>
  );
}
