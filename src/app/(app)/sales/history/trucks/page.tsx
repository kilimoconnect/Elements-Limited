import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { truckSales, truckTotals, truckFiltersFrom, TRUCK_SALE_STATUS } from "@/lib/reports/sales-trucks";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ClickableRow } from "@/components/common/clickable-row";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PeriodFilter, ParamSelect, ExportButtons } from "@/components/reports/report-tools";
import { SearchBox } from "./search-box";
import { formatDateTime, formatMoney, formatQuantity, todayISO } from "@/lib/format";

export const metadata: Metadata = { title: "Sales by Truck" };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function SalesByTruckPage(props: { searchParams: SP }) {
  await requirePermissionPage("sales.view");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const today = todayISO();
  const f = truckFiltersFrom(sp, { start: `${today.slice(0, 7)}-01`, end: today });
  const rows = await truckSales(ctx.companyId, ctx.user.isOwner ? null : ctx.user.branchIds, f);
  const t = truckTotals(rows);
  const variant = (s: string) => (s === "voided" ? "destructive" : s === "collected" || s === "delivered" ? "success" : "warning") as "destructive" | "success" | "warning";

  return (
    <div className="space-y-4">
      <Button asChild variant="outline" size="sm"><Link href="/sales/history"><ArrowLeft className="h-4 w-4" /> Back to sales history</Link></Button>
      <PageHeader title="Sales by Truck"
        description="Every truck dispatched in the period with its customer, order, crew, documents, cargo and invoice. Voided trucks are listed but not counted in the totals."
        actions={<ExportButtons api="/api/reports/sales-trucks" />} />
      <div className="flex flex-wrap items-end gap-2">
        <PeriodFilter start={f.start} end={f.end} />
        <ParamSelect param="branch" value={f.branch ?? ""} placeholder="All branches" options={ctx.branches.map((b) => ({ id: b.id, label: b.name }))} />
        <ParamSelect param="status" value={f.status ?? ""} placeholder="Any status" options={Object.entries(TRUCK_SALE_STATUS).map(([id, label]) => ({ id, label }))} />
        <SearchBox value={f.q ?? ""} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4"><p className="text-xs text-muted-foreground">Trucks</p><p className="text-xl font-semibold tabular-nums">{t.trucks}</p>{t.voided > 0 && <p className="text-xs text-muted-foreground">+{t.voided} voided</p>}</Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Quantity sold</p><p className="text-xl font-semibold tabular-nums">{formatQuantity(t.quantity)}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Sales value</p><p className="text-xl font-semibold tabular-nums">{formatMoney(t.total)}</p><p className="text-xs text-muted-foreground">VAT {formatMoney(t.vat)}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Paid</p><p className="text-xl font-semibold tabular-nums">{formatMoney(t.paid)}</p>{t.outstanding > 0.005 && <p className="text-xs text-destructive">Outstanding {formatMoney(t.outstanding)}</p>}</Card>
      </div>

      {rows.length === 0 ? <EmptyState title="No trucks for these filters" description="Change the period or clear the filters to see past trucks." /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Dispatched</TableHead><TableHead>Truck</TableHead><TableHead>Customer / order</TableHead><TableHead>Branch</TableHead>
              <TableHead>Documents</TableHead><TableHead>Cargo</TableHead><TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Value</TableHead><TableHead className="text-right">Paid</TableHead><TableHead>Status</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <ClickableRow key={r.id} href={`/sales/shipments/${r.id}`}>
                  <TableCell className="whitespace-nowrap text-xs">{r.dispatchedAt ? formatDateTime(r.dispatchedAt) : "—"}</TableCell>
                  <TableCell className="text-sm"><span className="font-medium">{r.vehicle ?? "—"}</span>{r.trailer && <span className="text-muted-foreground"> / {r.trailer}</span>}
                    <span className="block text-xs text-muted-foreground">{r.truck} · {r.driver ?? "—"}{r.driverPhone ? ` · ${r.driverPhone}` : ""}</span></TableCell>
                  <TableCell className="text-sm">{r.customer}<span className="block text-xs text-muted-foreground">{r.order} · {r.mode === "delivery" ? "delivery" : "collection"}</span></TableCell>
                  <TableCell className="text-sm">{r.branch}</TableCell>
                  <TableCell className="text-xs">{r.invoice ?? "—"}<span className="block text-muted-foreground">{r.deliveryNote ? `DN ${r.deliveryNote}` : ""}</span></TableCell>
                  <TableCell className="text-xs">{r.lines.map((l, i) => <span key={i} className="block">{formatQuantity(l.qty)} {l.unit} {l.product}</span>)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.status === "voided" ? "—" : formatQuantity(r.quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.status === "voided" ? "—" : formatMoney(r.total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.status === "voided" ? "—" : formatMoney(r.paid)}</TableCell>
                  <TableCell><Badge variant={variant(r.status)}>{TRUCK_SALE_STATUS[r.status] ?? r.status}</Badge>
                    {r.receivedBy && r.status !== "voided" && <span className="block text-xs text-muted-foreground">{r.receivedBy}</span>}
                    {r.voidReason && <span className="block text-xs text-muted-foreground">{r.voidReason}</span>}</TableCell>
                </ClickableRow>
              ))}
              <TableRow className="border-t-2 bg-muted/40 font-semibold hover:bg-muted/40">
                <TableCell colSpan={6}>Total ({t.trucks} truck{t.trucks === 1 ? "" : "s"})</TableCell>
                <TableCell className="text-right tabular-nums">{formatQuantity(t.quantity)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(t.total)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(t.paid)}</TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
