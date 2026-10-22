import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePeriod, type SP } from "@/lib/reports/period";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PeriodFilter, ParamSelect, PrintButton, ExportCsvButton } from "@/components/reports/report-tools";
import { Pager, PAGE_SIZE, pageOf, str } from "@/components/reports/pager";
import { formatMoney, formatQuantity } from "@/lib/format";

export const metadata: Metadata = { title: "Profitability" };
const N = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const DIMS = [
  { id: "item", label: "By item" }, { id: "pack", label: "By pack size" }, { id: "branch", label: "By branch" },
  { id: "branch_item", label: "By branch and item" }, { id: "shipment", label: "By shipment (allocated)" },
];

interface Row { key: string; label: string; qty: number; revenue: number; cogs: number; returnsRev: number; returnsCogs: number; late: number }

export default async function ProfitabilityPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("reports.view_profit_loss");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const { start, end } = resolvePeriod(sp);
  const dim = str(sp, "by") || "item";
  const page = pageOf(sp);
  const admin = createAdminClient();
  const scope = ctx.user.isOwner ? null : new Set(ctx.user.branchIds);
  const [{ data: products }, { data: branches }] = await Promise.all([
    admin.from("products").select("id, sku, name, stock_role, net_weight_kg").eq("company_id", ctx.companyId),
    admin.from("branches").select("id, code").eq("company_id", ctx.companyId),
  ]);
  const pm = new Map((products ?? []).map((p) => [p.id, p]));
  const bm = new Map((branches ?? []).map((b) => [b.id, b.code]));
  const pack = (pid: string) => { const p = pm.get(pid); return p?.stock_role === "bulk" ? "Bulk (kg)" : p?.net_weight_kg ? `${Number(p.net_weight_kg)} kg bag` : "Other"; };
  const acc = new Map<string, Row>();
  const add = (key: string, label: string, v: Partial<Row>) => {
    const r = acc.get(key) ?? { key, label, qty: 0, revenue: 0, cogs: 0, returnsRev: 0, returnsCogs: 0, late: 0 };
    r.qty += v.qty ?? 0; r.revenue += v.revenue ?? 0; r.cogs += v.cogs ?? 0; r.returnsRev += v.returnsRev ?? 0; r.returnsCogs += v.returnsCogs ?? 0; r.late += v.late ?? 0;
    acc.set(key, r);
  };
  let note = "";
  if (dim === "shipment") {
    const [{ data: tr }, { data: ships }] = await Promise.all([
      admin.rpc("shipment_sales_trace", { p_company: ctx.companyId, p_from: start, p_to: end }),
      admin.from("import_shipments").select("id, document_number").eq("company_id", ctx.companyId),
    ]);
    const sm = new Map((ships ?? []).map((s) => [s.id, s.document_number ?? "—"]));
    for (const t of (tr ?? []) as { shipment_id: string; branch_id: string; product_id: string; units: number; revenue: number; cogs: number }[]) {
      if (scope && !scope.has(t.branch_id)) continue;
      if (N(t.units) <= 0) continue;
      add(t.shipment_id, sm.get(t.shipment_id) ?? "—", { qty: N(t.units), revenue: N(t.revenue), cogs: N(t.cogs) });
    }
    note = "Shipment figures are an allocation: sales come from blended weighted-average pools, so each sale is attributed to shipments in proportion to the units of each shipment still in the pool when it was sold (the same replay the costing engine uses, through rebagging and transfers). Cost of sales is the blended average at the time of sale, not the shipment's own lot cost. Units are base units of the product sold (kg for bulk, bags for packed SKUs). Returns and later cost adjustments are reported under the other views.";
  } else {
    const { data } = await admin.rpc("sales_profitability", { p_company: ctx.companyId, p_from: start, p_to: end });
    for (const r of (data ?? []) as { branch_id: string; product_id: string; qty_sold: number; revenue: number; cogs: number; qty_returned: number; returns_revenue: number; returns_cogs: number; late_cost: number }[]) {
      if (scope && !scope.has(r.branch_id)) continue;
      const p = pm.get(r.product_id);
      const key = dim === "pack" ? pack(r.product_id) : dim === "branch" ? r.branch_id : dim === "branch_item" ? `${r.branch_id}:${r.product_id}` : r.product_id;
      const label = dim === "pack" ? key : dim === "branch" ? bm.get(r.branch_id) ?? "—" : dim === "branch_item" ? `${bm.get(r.branch_id)} · ${p?.sku} ${p?.name}` : `${p?.sku} ${p?.name}`;
      add(key, label, { qty: N(r.qty_sold) - N(r.qty_returned), revenue: N(r.revenue), cogs: N(r.cogs), returnsRev: N(r.returns_revenue), returnsCogs: N(r.returns_cogs), late: N(r.late_cost) });
    }
    note = "Revenue is net of VAT. Cost of sales is the weighted-average cost recorded on each sale; late cost adjustments are shown in the period they were posted (catch-ups for closed periods included), so a period's gross margin = net revenue − cost of sales at sale + returns − late adjustments.";
  }
  const all = Array.from(acc.values()).map((r) => {
    const net = r2(r.revenue - r.returnsRev), cost = r2(r.cogs - r.returnsCogs + r.late);
    return { ...r, net, cost, gp: r2(net - cost), gm: net ? r2((net - cost) / net * 100) : 0 };
  }).sort((a, b) => b.net - a.net);
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const tot = all.reduce((a, r) => ({ net: a.net + r.net, cost: a.cost + r.cost, late: a.late + r.late }), { net: 0, cost: 0, late: 0 });
  return (
    <div>
      <PageHeader title="Profitability" description="Gross profit from posted sales (TZS) at accounting cost, by item, pack size, branch or shipment provenance."
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename={`profitability-${dim}.csv`}
          header={["Group", "Net qty", "Revenue", "Returns", "Net revenue", "Cost at sale", "Returns cost", "Late adjustments", "Cost of sales", "Gross profit", "Gross margin %"]}
          rows={all.map((r) => [r.label, r2(r.qty), r2(r.revenue), r2(r.returnsRev), r.net, r2(r.cogs), r2(r.returnsCogs), r2(r.late), r.cost, r.gp, r.gm])} /></div>} />
      <div className="mb-4 flex flex-wrap items-end gap-3"><PeriodFilter start={start} end={end} />
        <ParamSelect param="by" value={dim} placeholder="Group by" options={DIMS} /></div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4"><p className="text-xs text-muted-foreground">Net revenue</p><p className="text-lg font-semibold tabular-nums">{formatMoney(tot.net)}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Cost of sales</p><p className="text-lg font-semibold tabular-nums">{formatMoney(tot.cost)}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Gross profit</p><p className="text-lg font-semibold tabular-nums">{formatMoney(tot.net - tot.cost)}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Of which late adjustments</p><p className="text-lg font-semibold tabular-nums">{formatMoney(tot.late)}</p></Card>
      </div>
      {all.length === 0 ? <EmptyState title="No sales in this period" /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>{DIMS.find((x) => x.id === dim)?.label.replace("By ", "") ?? "Group"}</TableHead><TableHead className="text-right">Net qty</TableHead><TableHead className="text-right">Net revenue</TableHead>
              <TableHead className="text-right">Cost at sale (net of returns)</TableHead><TableHead className="text-right">Late adjustments</TableHead><TableHead className="text-right">Gross profit</TableHead><TableHead className="text-right">Margin</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell>{r.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(r.qty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.net)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r2(r.cogs - r.returnsCogs))}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.late ? formatMoney(r.late) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatMoney(r.gp)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.gm.toFixed(1)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <Pager basePath="/reports/profitability" params={{ start, end, by: dim }} page={page} pageSize={PAGE_SIZE} total={all.length} />
      <p className="mt-2 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}
