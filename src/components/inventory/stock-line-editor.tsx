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

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Product</th>
              <th className="px-3 py-2 text-right font-medium">{qtyLabel}</th>
              {showCost && <th className="px-3 py-2 text-right font-medium">Unit cost</th>}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key} className="border-t border-border">
                <td className="px-2 py-1.5">
                  <Select value={l.product_id} onValueChange={(v) => {
                    const p = products.find((x) => x.id === v);
                    update(l.key, { product_id: v, unit_cost: l.unit_cost || (p?.selling_price ? "" : l.unit_cost) });
                  }}>
                    <SelectTrigger className="h-8"><SelectValue placeholder={available && products.length === 0 ? "No products in stock" : "Select product"} /></SelectTrigger>
                    <SelectContent>
                      {products.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.sku} — {p.name}{available ? `  (in stock: ${Number(available[p.id] ?? 0).toLocaleString("en-US", { maximumFractionDigits: 4 })})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-2 py-1.5">
                  <Input className={`h-8 text-right tabular-nums ${over(l) ? "border-destructive focus-visible:ring-destructive" : ""}`} type="number" step="0.0001" min="0"
                    max={available && l.product_id ? available[l.product_id] ?? 0 : undefined}
                    value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                  {over(l) && <p className="pt-0.5 text-right text-xs font-medium text-destructive">Only {available![l.product_id] ?? 0} in stock</p>}
                </td>
                {showCost && (
                  <td className="px-2 py-1.5">
                    <Input className="h-8 text-right tabular-nums" type="number" step="0.01" min="0"
                      value={l.unit_cost} onChange={(e) => update(l.key, { unit_cost: e.target.value })} />
                  </td>
                )}
                <td className="px-2 py-1.5 text-center">
                  <button type="button" onClick={() => remove(l.key)} className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
            {lines.length === 0 && (
              <tr><td colSpan={showCost ? 4 : 3} className="px-3 py-6 text-center text-sm text-muted-foreground">No lines yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, newLine()])}>
        <Plus className="h-4 w-4" /> Add line
      </Button>
    </div>
  );
}
