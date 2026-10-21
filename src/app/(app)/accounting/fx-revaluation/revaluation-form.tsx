"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { postFxRevaluation, voidFxRevaluation } from "@/lib/fx/actions";
import { round2 } from "@/lib/sales/calc";
import { formatMoney, formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/** One open foreign balance (invoice or supplier credit). kind: payable = liability, credit = asset. */
export interface OpenBalance { currency: string; kind: "payable" | "credit"; fc: number; carrying: number }
export interface TableRate { currency: string; date: string; rate: number }
export interface RevaluationRow { id: string; document_number: string | null; revaluation_date: string; status: string; total_loss: number; total_gain: number }

const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function RevaluationForm({ balances, tableRates, history }: { balances: OpenBalance[]; tableRates: TableRate[]; history: RevaluationRow[] }) {
  const router = useRouter();
  const currencies = Array.from(new Set(balances.map((b) => b.currency))).sort();
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [rates, setRates] = React.useState<Record<string, { rate: string; source: "manual" | "rate_table"; reference: string }>>({});
  const [requestId, setRequestId] = React.useState(newRequestId);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [voidId, setVoidId] = React.useState<string | null>(null);

  const tableRateFor = (c: string) => tableRates.filter((r) => r.currency === c && r.date <= date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const setRate = (c: string, patch: Partial<{ rate: string; source: "manual" | "rate_table"; reference: string }>) => {
    const base = rates[c] ?? { rate: "", source: "manual" as const, reference: "" };
    setRates({ ...rates, [c]: { ...base, ...patch } });
  };

  // Preview per currency: new carrying at the closing rate vs current carrying.
  // (The posted amounts are computed per invoice / credit on the server.)
  const preview = currencies.map((c) => {
    const r = Number(rates[c]?.rate || 0);
    const pay = balances.filter((b) => b.currency === c && b.kind === "payable");
    const cred = balances.filter((b) => b.currency === c && b.kind === "credit");
    const payDiff = r > 0 ? round2(pay.reduce((s, b) => s + round2(b.fc * r) - b.carrying, 0)) : 0;
    const credDiff = r > 0 ? round2(cred.reduce((s, b) => s + round2(b.fc * r) - b.carrying, 0)) : 0;
    return {
      currency: c, rate: r,
      payFc: round2(pay.reduce((s, b) => s + b.fc, 0)), payCarrying: round2(pay.reduce((s, b) => s + b.carrying, 0)),
      credFc: round2(cred.reduce((s, b) => s + b.fc, 0)), credCarrying: round2(cred.reduce((s, b) => s + b.carrying, 0)),
      // Liability up = loss; asset up = gain.
      effect: round2(credDiff - payDiff),
    };
  });

  async function submit() {
    setError(null);
    const missing = currencies.filter((c) => !(Number(rates[c]?.rate) > 0));
    if (missing.length) { setError(`Enter a closing rate for ${missing.join(", ")}.`); return; }
    setPending(true);
    const res = await postFxRevaluation({
      date, requestId,
      rates: currencies.map((c) => ({ currency: c, rate: Number(rates[c].rate), source: rates[c].source, reference: rates[c].reference })),
    });
    setPending(false);
    if (res.ok) { toast.success("Revaluation posted."); setRequestId(newRequestId()); setRates({}); router.refresh(); }
    else setError(res.error ?? "Failed.");
  }

  return (
    <div className="space-y-4">
      {currencies.length === 0 ? (
        <Card><CardContent className="p-5 text-sm text-muted-foreground">There are no open foreign-currency supplier balances to revalue.</CardContent></Card>
      ) : (
        <Card><CardContent className="space-y-4 p-5">
          <div className="max-w-xs space-y-1.5"><Label>Revaluation date (period end)</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr>
              <th className="px-3 py-2 text-left">Currency</th>
              <th className="px-3 py-2 text-right">Open invoices</th><th className="px-3 py-2 text-right">Carrying TZS</th>
              <th className="px-3 py-2 text-right">Open credits</th><th className="px-3 py-2 text-right">Carrying TZS</th>
              <th className="px-3 py-2 text-left">Closing rate (TZS per 1)</th><th className="px-3 py-2 text-left">Reference</th>
              <th className="px-3 py-2 text-right">Effect (preview)</th>
            </tr></thead>
            <tbody>
              {preview.map((p) => {
                const tr = tableRateFor(p.currency);
                return (
                  <tr key={p.currency} className="border-t border-border align-top">
                    <td className="px-3 py-2 font-medium">{p.currency}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(p.payFc)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(p.payCarrying)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(p.credFc)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(p.credCarrying)}</td>
                    <td className="px-3 py-2">
                      <Input className="h-8 w-36 text-right tabular-nums" type="number" min="0" step="0.000001" value={rates[p.currency]?.rate ?? ""}
                        onChange={(e) => setRate(p.currency, { rate: e.target.value, source: "manual" })} />
                      <p className="mt-1 text-xs text-muted-foreground">{tr
                        ? <>Table {tr.rate} ({formatDate(tr.date)}) <button type="button" className="underline" onClick={() => setRate(p.currency, { rate: String(tr.rate), source: "rate_table" })}>use</button></>
                        : "No table rate"} · {rates[p.currency]?.source === "rate_table" ? "rate table" : "manual"}</p>
                    </td>
                    <td className="px-3 py-2"><Input className="h-8 w-40" value={rates[p.currency]?.reference ?? ""} onChange={(e) => setRate(p.currency, { reference: e.target.value })} placeholder="e.g. BOT closing" /></td>
                    <td className={`px-3 py-2 text-right tabular-nums ${p.effect < 0 ? "text-destructive" : ""}`}>
                      {p.rate > 0 ? <>{p.effect < 0 ? "Loss " : p.effect > 0 ? "Gain " : ""}{formatMoney(Math.abs(p.effect))}</> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground">
            Revaluation updates each open balance&apos;s TZS carrying amount to the closing rate and posts the difference as unrealised FX gain/loss.
            Later payments measure realised FX from the revalued amount. Inventory cost is never changed.
          </p>
          <div className="flex items-center justify-end gap-2">
            {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <Button onClick={submit} disabled={pending}>{pending ? "Posting..." : "Post revaluation"}</Button>
          </div>
        </CardContent></Card>
      )}

      <Card><CardContent className="p-0">
        <h3 className="px-5 pt-4 text-sm font-semibold">Revaluation history</h3>
        {history.length === 0 ? <p className="px-5 py-4 text-sm text-muted-foreground">No revaluations yet.</p> : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr>
              <th className="px-3 py-2 text-left">Number</th><th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Unrealised loss</th><th className="px-3 py-2 text-right">Unrealised gain</th><th />
            </tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">{h.document_number ?? "—"}</td>
                  <td className="px-3 py-2">{formatDate(h.revaluation_date)}</td>
                  <td className="px-3 py-2 capitalize">{h.status}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(h.total_loss)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(h.total_gain)}</td>
                  <td className="px-3 py-2 text-right">
                    {h.status === "posted" && <Button size="sm" variant="outline" onClick={() => setVoidId(h.id)}>Void</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent></Card>

      <ConfirmDialog
        open={voidId !== null}
        onOpenChange={(o) => { if (!o) setVoidId(null); }}
        title="Void revaluation"
        description="Restores the carrying amounts and posts a reversing journal. Not possible if later payments, returns or credits used the revalued amounts."
        confirmLabel="Void revaluation" destructive requireReason
        onConfirm={async (reason) => {
          if (!voidId) return;
          const res = await voidFxRevaluation(voidId, reason);
          if (!res.ok) return res.error ?? "Failed.";
          toast.success("Revaluation voided."); setVoidId(null); router.refresh();
        }} />
    </div>
  );
}
