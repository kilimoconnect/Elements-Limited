import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface AgeingData {
  rows: { entity: string; doc: string; date: string; due: string; original: number; outstanding: number; bucket: string;
    currency?: string; fcOriginal?: number | null; fcOutstanding?: number | null }[];
  buckets: { current: number; d1_30: number; d31_60: number; d61_90: number; d90: number };
  total: number; control: number; reconciled: boolean;
}
const BUCKET_LABEL: Record<string, string> = { current: "Not due", d1_30: "1–30", d31_60: "31–60", d61_90: "61–90", d90: "90+" };

export function AgeingView({ data, controlLabel }: { data: AgeingData; controlLabel: string }) {
  const foreign = data.rows.filter((r) => r.currency && r.currency !== "TZS");
  const hasForeign = foreign.length > 0;
  // Per-currency open balances, kept separate (never added to TZS).
  const fcTotals = Array.from(new Set(foreign.map((r) => r.currency!))).sort().map((c) => ({
    currency: c,
    fc: foreign.filter((r) => r.currency === c).reduce((s, r) => s + Number(r.fcOutstanding ?? 0), 0),
    carrying: foreign.filter((r) => r.currency === c).reduce((s, r) => s + r.outstanding, 0),
  }));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {(["current", "d1_30", "d31_60", "d61_90", "d90"] as const).map((k) => (
          <Card key={k} className="report-card p-4">
            <p className="text-xs text-muted-foreground">{BUCKET_LABEL[k]}</p>
            <p className="text-base font-semibold tabular-nums">{formatMoney(data.buckets[k])}</p>
          </Card>
        ))}
      </div>
      <Card className="report-card"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
        <div>Total outstanding (TZS{hasForeign ? ", foreign invoices at carrying amount" : ""}): <span className="font-semibold tabular-nums">{formatMoney(data.total)}</span></div>
        <div className="flex items-center gap-2">{controlLabel}: <span className="tabular-nums">{formatMoney(data.control)}</span>
          {data.reconciled ? <Badge variant="success">Reconciled</Badge> : <Badge variant="destructive">Difference {formatMoney(data.total - data.control)}</Badge>}
        </div>
      </CardContent></Card>
      {hasForeign && (
        <Card className="report-card"><CardContent className="flex flex-wrap gap-6 p-4 text-sm">
          {fcTotals.map((t) => (
            <div key={t.currency}>Open {t.currency}: <span className="font-semibold tabular-nums">{t.currency} {formatMoney(t.fc)}</span>
              <span className="text-muted-foreground"> · carrying TZS {formatMoney(t.carrying)}</span></div>
          ))}
        </CardContent></Card>
      )}
      {data.rows.length === 0 ? <EmptyState title="Nothing outstanding" /> : (
        <div className="report-card rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Party</TableHead><TableHead>Document</TableHead><TableHead>Date</TableHead><TableHead>Due</TableHead>
              {hasForeign && <><TableHead>Currency</TableHead><TableHead className="text-right">Open (currency)</TableHead></>}
              <TableHead className="text-right">Original (TZS)</TableHead><TableHead className="text-right">Outstanding (TZS)</TableHead><TableHead>Bucket</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {data.rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell className="text-sm">{r.entity}</TableCell>
                  <TableCell className="font-mono text-xs">{r.doc}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.date)}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.due)}</TableCell>
                  {hasForeign && <>
                    <TableCell className="text-sm">{r.currency ?? "TZS"}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.currency && r.currency !== "TZS" ? formatMoney(r.fcOutstanding ?? 0) : "—"}</TableCell>
                  </>}
                  <TableCell className="text-right tabular-nums">{formatMoney(r.original)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.outstanding)}</TableCell>
                  <TableCell><Badge variant={r.bucket === "current" ? "secondary" : r.bucket === "d90" ? "destructive" : "warning"}>{BUCKET_LABEL[r.bucket]}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
