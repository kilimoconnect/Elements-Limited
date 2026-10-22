import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { resolvePeriod, type SP } from "@/lib/reports/period";
import { rebagCosting } from "@/lib/reports/costing";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PeriodFilter, PrintButton, ExportCsvButton } from "@/components/reports/report-tools";
import { Pager, PAGE_SIZE, pageOf } from "@/components/reports/pager";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";

export const metadata: Metadata = { title: "Rebagging Costing" };

export default async function RebaggingCostingPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("inventory.view_cost");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const { start, end } = resolvePeriod(sp);
  const page = pageOf(sp);
  const all = await rebagCosting(ctx.companyId, ctx.user.isOwner ? null : ctx.user.branchIds, start, end);
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const sum = (f: (r: (typeof all)[number]) => number) => all.reduce((a, r) => a + f(r), 0);
  const csv = all.flatMap((r) => r.outputs.map((o) => [r.number, r.date ?? "", r.branch, r.bulk, r.issuedKg, r.packedKg, r.returnedKg, r.normalLossKg, r.abnormalLossKg,
    o.sku, o.name, o.bags, o.netKg, o.value, o.perBag, o.perKg, r.packagingValue, r.conversionValue, r.abnormalValue]));
  return (
    <div>
      <PageHeader title="Rebagging Costing" description="Completed rebagging orders: kg in, out and lost; bags and materials consumed; conversion costs; cost per output SKU (TZS, including later cost adjustments)."
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename="rebagging-costing.csv"
          header={["Order", "Completed", "Branch", "Bulk", "Issued kg", "Packed kg", "Returned kg", "Normal loss kg", "Abnormal loss kg", "Output SKU", "Output", "Bags", "Net kg", "Output value", "Per bag", "Per kg", "Packaging", "Conversion", "Abnormal loss value"]} rows={csv} /></div>} />
      <div className="mb-4"><PeriodFilter start={start} end={end} /></div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4"><p className="text-xs text-muted-foreground">Bulk issued</p><p className="text-lg font-semibold tabular-nums">{formatQuantity(sum((r) => r.issuedKg))} kg</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Bags produced</p><p className="text-lg font-semibold tabular-nums">{formatQuantity(sum((r) => r.outputs.reduce((a, o) => a + o.bags, 0)))}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Loss (normal / abnormal)</p><p className="text-lg font-semibold tabular-nums">{formatQuantity(sum((r) => r.normalLossKg))} / {formatQuantity(sum((r) => r.abnormalLossKg))} kg</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Packaging + conversion (TZS)</p><p className="text-lg font-semibold tabular-nums">{formatMoney(sum((r) => r.packagingValue + r.conversionValue))}</p></Card>
      </div>
      {all.length === 0 ? <EmptyState title="No completed rebagging in this period" /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Order</TableHead><TableHead className="text-right">Issued / packed / returned kg</TableHead><TableHead className="text-right">Loss kg (normal / abnormal)</TableHead>
              <TableHead>Materials</TableHead><TableHead className="text-right">Bulk / packaging / conversion</TableHead><TableHead>Cost per output SKU</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className="align-top">
                  <TableCell><Link className="font-mono text-xs underline" href={`/inventory/rebagging/${r.id}`}>{r.number}</Link><p className="text-xs text-muted-foreground">{r.date && formatDate(r.date)} · {r.branch} · {r.bulk} · {r.costing}</p></TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(r.issuedKg)} / {formatQuantity(r.packedKg)} / {formatQuantity(r.returnedKg)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(r.normalLossKg)} / {formatQuantity(r.abnormalLossKg)}{r.abnormalValue > 0 && <p className="text-xs text-muted-foreground">expensed {formatMoney(r.abnormalValue)}</p>}</TableCell>
                  <TableCell className="text-xs">{r.materials.map((m, i) => <p key={i}>{m.name}: {formatQuantity(m.qty)}{m.damaged ? ` (${formatQuantity(m.damaged)} damaged)` : ""} · {formatMoney(m.value)}</p>)}{r.materials.length === 0 && "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.bulkValue)}<p>{formatMoney(r.packagingValue)}</p><p>{formatMoney(r.conversionValue)}</p></TableCell>
                  <TableCell className="text-xs">{r.outputs.map((o, i) => <p key={i}><span className="font-mono">{o.sku}</span> {formatQuantity(o.bags)} bags · <span className="font-semibold tabular-nums">{formatMoney(o.perBag)}</span>/bag · {formatMoney(o.perKg)}/kg</p>)}
                    {r.lateAdjustments !== 0 && <p className="text-muted-foreground">incl. later adjustments {formatMoney(r.lateAdjustments)}</p>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <Pager basePath="/reports/rebagging-costing" params={{ start, end }} page={page} pageSize={PAGE_SIZE} total={all.length} />
    </div>
  );
}
