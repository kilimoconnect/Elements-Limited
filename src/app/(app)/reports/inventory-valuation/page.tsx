import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { inventoryValuation } from "@/lib/reports/subledger";
import { resolveAsOf, type SP } from "@/lib/reports/period";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { AsOfFilter, PrintButton, ExportCsvButton } from "@/components/reports/report-tools";
import { formatMoney, formatQuantity, formatDate, todayISO } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Inventory Valuation" };

export default async function InventoryValuationPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("reports.view_inventory_valuation");
  const ctx = await getActiveContext();
  const asOf = resolveAsOf(await props.searchParams);
  const isToday = asOf >= todayISO();
  const data = await inventoryValuation(ctx.companyId, null, asOf, isToday);

  return (
    <div>
      <PageHeader title="Inventory Valuation" description={`As of ${formatDate(asOf)} · ${isToday ? "current balances" : "reconstructed from stock movements"}`}
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename="inventory-valuation.csv" header={["SKU", "Product", "Branch", "Qty", "Avg cost", "Value"]}
          rows={data.rows.map((r) => [r.sku, r.name, r.branch, r.quantity, r.avgCost, r.value])} /></div>} />
      <div className="mb-4"><AsOfFilter asOf={asOf} /></div>
      <Card className="report-card mb-4"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
        <div>Total inventory value: <span className="font-semibold tabular-nums">{formatMoney(data.total)}</span></div>
        <div className="flex items-center gap-2">Inventory GL (1150): <span className="tabular-nums">{formatMoney(data.control)}</span>
          {data.reconciled ? <Badge variant="success">Reconciled</Badge> : <Badge variant="destructive">Difference {formatMoney(data.total + data.held - data.control)}</Badge>}</div>
        {data.held > 0 && <p className="w-full text-xs text-muted-foreground">Includes {formatMoney(data.held)} held outside branch stock (rebagging in production; transfers dispatched before the upgrade). Stock in transit between branches is in 1155.</p>}
      </CardContent></Card>
      {data.rows.length === 0 ? <EmptyState title="No stock on hand" /> : (
        <div className="report-card rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>Product</TableHead><TableHead>Branch</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Avg cost</TableHead><TableHead className="text-right">Value</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">{r.sku}</TableCell>
                  <TableCell className="text-sm">{r.name}</TableCell>
                  <TableCell className="text-sm">{r.branch}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(r.quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.avgCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.value)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
