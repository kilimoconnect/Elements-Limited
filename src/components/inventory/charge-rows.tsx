"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatMoney } from "@/lib/format";

export interface ChargeCategory { id: string; code: string; label: string }
export interface ChargeRow { key: string; categoryId: string; description: string; amount: string }

export function newCharge(categoryId = ""): ChargeRow {
  return { key: Math.random().toString(36).slice(2), categoryId, description: "", amount: "" };
}

/** Rows of transfer charges (type, note, amount in TZS) with a running total. */
export function ChargeRows({ categories, rows, setRows, notePlaceholder = "e.g. transporter, receipt no." }: {
  categories: ChargeCategory[]; rows: ChargeRow[]; setRows: (r: ChargeRow[]) => void; notePlaceholder?: string;
}) {
  const update = (key: string, patch: Partial<ChargeRow>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const total = rows.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-1 gap-2 sm:grid-cols-[14rem_1fr_10rem_auto]">
          <Select value={r.categoryId} onValueChange={(v) => update(r.key, { categoryId: v })}>
            <SelectTrigger><SelectValue placeholder="Charge type" /></SelectTrigger>
            <SelectContent>{categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input placeholder={notePlaceholder} value={r.description} onChange={(e) => update(r.key, { description: e.target.value })} />
          <Input className="text-right tabular-nums" type="number" min="0" step="0.01" placeholder="Amount (TZS)" value={r.amount}
            onChange={(e) => update(r.key, { amount: e.target.value })} />
          <Button type="button" variant="ghost" size="icon" aria-label="Remove charge" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, newCharge()])}>
          <Plus className="h-4 w-4" /> Add charge
        </Button>
        {rows.length > 0 && <span className="text-sm tabular-nums">Total {formatMoney(total)}</span>}
      </div>
    </div>
  );
}

/** Rows with an amount, ready for the server; null when one is incomplete. */
export function parseCharges(rows: ChargeRow[]): { categoryId: string; description: string; amount: number }[] | null {
  const used = rows.filter((r) => r.categoryId || r.amount || r.description);
  if (used.some((r) => !r.categoryId || !(Number(r.amount) > 0))) return null;
  return used.map((r) => ({ categoryId: r.categoryId, description: r.description.trim(), amount: Number(r.amount) }));
}
