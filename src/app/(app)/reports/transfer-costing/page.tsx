import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { resolvePeriod, type SP } from "@/lib/reports/period";
import { transferCosting } from "@/lib/reports/costing";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PeriodFilter, PrintButton, ExportCsvButton } from "@/components/reports/report-tools";
import { Pager, PAGE_SIZE, pageOf } from "@/components/reports/pager";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";

export const metadata: Metadata = { title: "Transfer Costing" };

export default async function TransferCostingPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("inventory.view_cost");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const { start, end } = resolvePeriod(sp);
  const page = pageOf(sp);
  const all = await transferCosting(ctx.companyId, ctx.user.isOwner ? null : ctx.user.branchIds, start, end);
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const sum = (k: keyof (typeof all)[number]) => all.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  return (
    <div>
      <PageHeader title="Transfer Costing" description="Per transfer line (TZS): value at the sending branch's weighted average, capitalised loading / transport / offloading / other charges (by the line's share of value dispatched), value received into the destination, the incoming unit cost and the destination's average after receipt."
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename="transfer-costing.csv"
          header={["Transfer", "Date", "From", "To", "SKU", "Product", "Dispatched", "Received", "Source value", "Loading", "Transport", "Offloading", "Other", "Charges applied", "Received value", "In transit", "Lost", "Incoming per unit", "Destination average after"]}
          rows={all.map((r) => [r.number, r.date, r.from, r.to, r.sku, r.product, r.dispatched, r.received, r.sourceValue, r.loading, r.transport, r.offloading, r.other, r.chargesApplied, r.receivedValue, r.inTransitValue, r.lostValue, r.incomingUnit ?? "", r.destAvgAfter ?? ""])} /></div>} />
      <div className="mb-4"><PeriodFilter start={start} end={end} /></div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4"><p className="text-xs text-muted-foreground">Source value</p><p className="text-lg font-semibold tabular-nums">{formatMoney(sum("sourceValue"))}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Charges applied</p><p className="text-lg font-semibold tabular-nums">{formatMoney(sum("chargesApplied"))}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Received value</p><p className="text-lg font-semibold tabular-nums">{formatMoney(sum("receivedValue"))}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Still in transit</p><p className="text-lg font-semibold tabular-nums">{formatMoney(sum("inTransitValue"))}</p></Card>
      </div>
      {all.length === 0 ? <EmptyState title="No transfers in this period" /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Transfer</TableHead><TableHead>Product</TableHead><TableHead className="text-right">Dispatched / received</TableHead><TableHead className="text-right">Source value</TableHead>
              <TableHead className="text-right">Loading</TableHead><TableHead className="text-right">Transport</TableHead><TableHead className="text-right">Offloading</TableHead><TableHead className="text-right">Other</TableHead>
              <TableHead className="text-right">Received value</TableHead><TableHead className="text-right">Incoming / unit</TableHead><TableHead className="text-right">Dest. average after</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={`${r.id}:${i}`}>
                  <TableCell><Link className="font-mono text-xs underline" href={`/inventory/transfers/${r.id}`}>{r.number}</Link><p className="text-xs text-muted-foreground">{formatDate(r.date)} · {r.from} → {r.to} · {r.costing}</p></TableCell>
                  <TableCell className="text-sm"><span className="font-mono text-xs">{r.sku}</span> {r.product}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(r.dispatched)} / {formatQuantity(r.received)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.sourceValue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.loading)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.transport)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.offloading)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.other)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.receivedValue)}{r.inTransitValue > 0 && <p className="text-xs text-muted-foreground">{formatMoney(r.inTransitValue)} in transit</p>}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.incomingUnit == null ? "—" : formatMoney(r.incomingUnit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.destAvgAfter == null ? "—" : formatMoney(r.destAvgAfter)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <Pager basePath="/reports/transfer-costing" params={{ start, end }} page={page} pageSize={PAGE_SIZE} total={all.length} />
      <p className="mt-2 text-xs text-muted-foreground">Charges are split by kind from their category (loading / transport); &quot;offloading&quot; is identified from the charge description. Transfers dispatched before the transfer upgrade are not listed.</p>
    </div>
  );
}
