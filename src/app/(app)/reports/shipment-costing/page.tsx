import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { resolvePeriod, type SP } from "@/lib/reports/period";
import { shipmentCosting } from "@/lib/reports/costing";
import { COST_LABEL, LOGISTICS_LABEL } from "@/lib/imports/queries";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PeriodFilter, ParamSelect, PrintButton, ExportCsvButton } from "@/components/reports/report-tools";
import { Pager, PAGE_SIZE, pageOf, str } from "@/components/reports/pager";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";

export const metadata: Metadata = { title: "Shipment Costing" };

export default async function ShipmentCostingPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("imports.view_cost");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const { start, end } = resolvePeriod(sp);
  const status = str(sp, "costing");
  const page = pageOf(sp);
  const all = await shipmentCosting(ctx.companyId, start, end, status);
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const tot = (k: keyof (typeof all)[number]) => all.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const money = (v: number | null) => (v == null ? "—" : formatMoney(v));
  return (
    <div>
      <PageHeader title="Shipment Costing" description="Per shipment, in TZS: goods (purchase basis) and eligible acquisition costs, estimated vs actual; expensed linked charges; unallocated charges; accrual variances; received kg and cost per kg / MT."
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename="shipment-costing.csv"
          header={["Shipment", "Supplier", "Basis", "Logistics", "Costing", "Expected kg", "Received kg", "Goods est", "Goods actual", "Capitalised est", "Capitalised actual", "Expensed linked", "Unallocated", "Accrual variance", "Est per kg", "Actual per kg", "Actual per MT"]}
          rows={all.map((r) => [r.number, r.supplier, r.basis, r.logistics, r.costing, r.expectedKg, r.receivedKg, r.goodsEst, r.goodsAct, r.capEst, r.capAct, r.expensed, r.unallocated, r.accrualVariance,
            r.estPerKg ?? "", r.actPerKg ?? "", r.actPerKg == null ? "" : r.actPerKg * 1000])} /></div>} />
      <div className="mb-4 flex flex-wrap items-end gap-3"><PeriodFilter start={start} end={end} />
        <ParamSelect param="costing" value={status} placeholder="All costing states" options={Object.entries(COST_LABEL).map(([id, label]) => ({ id, label }))} /></div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4"><p className="text-xs text-muted-foreground">Received</p><p className="text-lg font-semibold tabular-nums">{formatQuantity(tot("receivedKg") / 1000)} MT</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Actual goods + capitalised (TZS)</p><p className="text-lg font-semibold tabular-nums">{formatMoney(tot("goodsAct") + tot("capAct"))}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Expensed linked charges (TZS)</p><p className="text-lg font-semibold tabular-nums">{formatMoney(tot("expensed"))}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Unallocated (TZS)</p><p className={`text-lg font-semibold tabular-nums ${tot("unallocated") ? "text-destructive" : ""}`}>{formatMoney(tot("unallocated"))}</p></Card>
      </div>
      {all.length === 0 ? <EmptyState title="No shipments in this period" /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Shipment</TableHead><TableHead>Basis</TableHead><TableHead className="text-right">Received / expected kg</TableHead>
              <TableHead className="text-right">Goods est / actual</TableHead><TableHead className="text-right">Capitalised est / actual</TableHead>
              <TableHead className="text-right">Expensed linked</TableHead><TableHead className="text-right">Unallocated</TableHead><TableHead className="text-right">Accrual variance</TableHead>
              <TableHead className="text-right">Per kg est / actual</TableHead><TableHead className="text-right">Per MT actual</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell><Link className="font-mono text-xs underline" href={`/imports/${r.id}`}>{r.number}</Link><p className="text-xs text-muted-foreground">{r.supplier}{r.eta && ` · ETA ${formatDate(r.eta)}`}</p>
                    <Badge variant="secondary" className="mr-1">{LOGISTICS_LABEL[r.logistics] ?? r.logistics}</Badge><Badge variant={r.costing === "finalized" ? "success" : "warning"}>{COST_LABEL[r.costing] ?? r.costing}</Badge></TableCell>
                  <TableCell className="text-xs">{r.basis} · {r.currency}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(r.receivedKg)} / {formatQuantity(r.expectedKg)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.goodsEst)}<p>{formatMoney(r.goodsAct)}</p></TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.capEst)}<p>{formatMoney(r.capAct)}</p></TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.expensed)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${r.unallocated ? "text-destructive" : ""}`}>{formatMoney(r.unallocated)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.accrualVariance)}{r.awaitingInvoice > 0 && <p className="text-xs text-warning">{r.awaitingInvoice} awaiting invoice</p>}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.estPerKg)}<p>{money(r.actPerKg)}</p></TableCell>
                  <TableCell className="text-right tabular-nums">{r.actPerKg == null ? "—" : formatMoney(r.actPerKg * 1000)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <Pager basePath="/reports/shipment-costing" params={{ start, end, costing: status }} page={page} pageSize={PAGE_SIZE} total={all.length} />
      <p className="mt-2 text-xs text-muted-foreground">Estimated figures use planning rates and estimates (never posted); actual figures are posted values. Costing &quot;Provisional&quot; means accruals still await their invoices.</p>
    </div>
  );
}
