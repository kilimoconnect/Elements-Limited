import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { type SP } from "@/lib/reports/period";
import { branchLandedCost } from "@/lib/reports/costing";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ParamSelect, PrintButton, ExportCsvButton } from "@/components/reports/report-tools";
import { Pager, PAGE_SIZE, pageOf, str } from "@/components/reports/pager";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";

export const metadata: Metadata = { title: "Branch Landed Cost" };
const PACKS = ["50", "25", "5"];

export default async function BranchLandedCostPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("inventory.view_cost");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const branch = str(sp, "branch"), pack = str(sp, "pack") || "50", q = str(sp, "q").toLowerCase();
  const page = pageOf(sp);
  const scope = ctx.user.isOwner ? null : ctx.user.branchIds;
  const all = (await branchLandedCost(ctx.companyId, scope))
    .filter((r) => (!branch || r.branchId === branch) && (!q || `${r.sku} ${r.name}`.toLowerCase().includes(q)))
    .sort((a, b) => a.branch.localeCompare(b.branch) || a.name.localeCompare(b.name));
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const packKg = Number(pack);
  const branches = ctx.branches.filter((b) => !scope || scope.includes(b.id));
  return (
    <div>
      <PageHeader title="Branch Landed Cost" description={`Current position per branch (TZS). Inventory cost is each branch's posted weighted average (stock value / quantity), including import, rebagging and transfer costs. "Per ${pack} kg" converts the per-kg cost to the selected pack size.`}
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename="branch-landed-cost.csv"
          header={["Branch", "SKU", "Product", "Qty", "Stock value", "Inventory cost per unit", "Per kg", `Per ${pack} kg`, "Last incoming transfer per unit", "Approved selling price"]}
          rows={all.map((r) => [r.branch, r.sku, r.name, r.qty, r.value, r.avgCost, r.perKg ?? "", r.perKg == null ? "" : r.perKg * packKg, r.lastIncomingUnit ?? "", r.sellingPrice])} /></div>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ParamSelect param="branch" value={branch} placeholder="All my branches" options={branches.map((b) => ({ id: b.id, label: `${b.code} — ${b.name}` }))} />
        <ParamSelect param="pack" value={pack} placeholder="Pack size" options={PACKS.map((p) => ({ id: p, label: `Per ${p} kg bag` }))} />
        <form className="print-hide"><input name="q" defaultValue={q} placeholder="Search SKU / name" className="h-8 rounded-md border border-input bg-card px-2 text-sm" />
          {branch && <input type="hidden" name="branch" value={branch} />}<input type="hidden" name="pack" value={pack} /></form>
      </div>
      {all.length === 0 ? <EmptyState title="No stock on hand" /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Branch / product</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Inventory cost / unit</TableHead>
              <TableHead className="text-right">Per kg</TableHead><TableHead className="text-right">Per {pack} kg</TableHead><TableHead className="text-right">Last incoming transfer / unit</TableHead>
              <TableHead className="text-right">Approved price</TableHead><TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.branchId}:${r.productId}`}>
                  <TableCell>{r.branch} · <span className="font-mono text-xs">{r.sku}</span> {r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(r.qty)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatMoney(r.avgCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.perKg == null ? "—" : formatMoney(r.perKg)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.perKg == null ? "—" : formatMoney(r.perKg * packKg)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.lastIncomingUnit == null ? "—" : <>{formatMoney(r.lastIncomingUnit)}<p className="text-xs text-muted-foreground">{r.lastIncomingDate && formatDate(r.lastIncomingDate)}</p></>}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.sellingPrice)}</TableCell>
                  <TableCell><Link className="text-xs underline print-hide" href={`/inventory/pricing?branch=${r.branchId}&product=${r.productId}`}>Price</Link></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <Pager basePath="/reports/branch-landed-cost" params={{ branch, pack, q }} page={page} pageSize={PAGE_SIZE} total={all.length} />
    </div>
  );
}
