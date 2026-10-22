import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePeriod, type SP } from "@/lib/reports/period";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PeriodFilter, PrintButton, ExportCsvButton } from "@/components/reports/report-tools";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";

export const metadata: Metadata = { title: "Late Cost Adjustments" };

const TARGET: Record<string, string> = {
  stock: "Stock held", cogs: "Cost of sales", loss: "Loss / write-off", ppv: "Price variance", transit: "Stock in transit (1155)",
  transit_legacy: "In transit (pre-upgrade)", import_transit: "Import goods in transit (1157)", wip: "Rebagging in production", return_restore: "Back to stock (returned units)",
};
const SRC: Record<string, string> = {
  cost_invoice: "Cost invoice", cost_accrual: "Accrual", cost_invoice_void: "Invoice reversal", purchase_cost_adjustment: "Supplier price note",
  purchase: "Goods invoice", purchase_void: "Goods invoice void", sales_return: "Sales return", sales_return_void: "Return void", sale_void: "Sale void",
};

export default async function LateCostsPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("reports.view_inventory_valuation");
  const ctx = await getActiveContext();
  const { start, end } = resolvePeriod(await props.searchParams);
  const admin = createAdminClient();
  const { data } = await admin.rpc("late_cost_report", { p_company: ctx.companyId, p_from: start, p_to: end });
  type R = { src_type: string; src_id: string; src_number: string | null; posting_date: string | null; target: string; branch_code: string | null; product_name: string | null;
    ref_type: string | null; ref_number: string | null; ref_date: string | null; units: number | null; amount: number; catch_up: boolean };
  const rows = (data ?? []) as R[];
  const byTarget = new Map<string, number>();
  for (const r of rows) byTarget.set(r.target, (byTarget.get(r.target) ?? 0) + Number(r.amount));
  const catchUps = rows.filter((r) => r.catch_up);
  return (
    <div>
      <PageHeader title="Late Cost Adjustments" description="Every cost difference posted after the goods moved, where it went, and the original documents it reached. Nothing is backdated: late costs on sales in closed periods are posted in the open period and flagged as catch-ups."
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename="late-cost-adjustments.csv"
          header={["Posted", "Source", "Number", "Target", "Branch", "Product", "Reaches", "Reference", "Reference date", "Units", "Amount", "Catch-up"]}
          rows={rows.map((r) => [r.posting_date ?? "", SRC[r.src_type] ?? r.src_type, r.src_number ?? "", TARGET[r.target] ?? r.target, r.branch_code ?? "", r.product_name ?? "",
            r.ref_type ?? "", r.ref_number ?? "", r.ref_date ?? "", r.units ?? "", Number(r.amount), r.catch_up ? "yes" : ""])} /></div>} />
      <div className="mb-4"><PeriodFilter start={start} end={end} /></div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from(byTarget).map(([t, v]) => (
          <Card key={t} className="p-4"><p className="text-xs text-muted-foreground">{TARGET[t] ?? t}</p><p className="text-lg font-semibold tabular-nums">{formatMoney(v)}</p></Card>
        ))}
        <Card className="p-4"><p className="text-xs text-muted-foreground">Catch-ups for closed periods</p><p className="text-lg font-semibold tabular-nums">{formatMoney(catchUps.reduce((a, r) => a + Number(r.amount), 0))}</p></Card>
      </div>
      {rows.length === 0 ? <EmptyState title="No late cost adjustments in this period" /> : (
        <Card><CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Posted</TableHead><TableHead>Source</TableHead><TableHead>Went to</TableHead><TableHead>Branch / product</TableHead>
              <TableHead>Original document</TableHead><TableHead className="text-right">Units</TableHead><TableHead className="text-right">Amount</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell>{r.posting_date ? formatDate(r.posting_date) : "—"}</TableCell>
                  <TableCell className="text-xs">{SRC[r.src_type] ?? r.src_type}<p className="font-mono">{r.src_number ?? ""}</p></TableCell>
                  <TableCell className="text-xs">{TARGET[r.target] ?? r.target}</TableCell>
                  <TableCell className="text-xs">{r.branch_code ?? "—"} · {r.product_name ?? "—"}</TableCell>
                  <TableCell className="text-xs">{r.ref_number ?? "—"}{r.ref_date && ` · ${formatDate(r.ref_date)}`}{r.catch_up && <Badge variant="warning" className="ml-1">catch-up</Badge>}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.units == null ? "—" : formatQuantity(Number(r.units))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(Number(r.amount))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}
    </div>
  );
}
