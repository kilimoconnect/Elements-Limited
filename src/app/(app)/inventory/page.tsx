import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ListToolbar } from "@/components/common/list-toolbar";
import { ClickableRow } from "@/components/common/clickable-row";
import { formatMoney, formatQuantity, formatDate } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Current Stock" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function InventoryPage(props: { searchParams: SP }) {
  await requirePermissionPage("inventory.view");
  const ctx = await getActiveContext();
  const showCost = can(ctx.user, "inventory.view_cost");
  const admin = createAdminClient();

  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const branch = typeof sp.branch === "string" ? sp.branch : "";
  const low = sp.low === "1";

  let productIds: string[] | null = null;
  if (q) {
    const { data } = await admin.from("products").select("id")
      .eq("company_id", ctx.companyId).or(`sku.ilike.%${q}%,name.ilike.%${q}%`);
    productIds = (data ?? []).map((p) => p.id);
    if (productIds.length === 0) productIds = ["00000000-0000-0000-0000-000000000000"];
  }

  let query = admin.from("stock_balances")
    .select("id, quantity, avg_unit_cost, stock_value, qty_in_transit, last_movement_at, branch_id, product_id, product:products(sku, name, reorder_level, is_active, category:product_categories(name), brand:brands(name), unit:units(symbol)), branch:branches(name, code)")
    .eq("company_id", ctx.companyId)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (branch) query = query.eq("branch_id", branch);
  else if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  if (productIds) query = query.in("product_id", productIds);

  const { data: rows } = await query;
  type Row = {
    id: string; quantity: number; avg_unit_cost: number; stock_value: number;
    qty_in_transit: number; last_movement_at: string | null; product_id: string; branch_id: string;
    product: { sku: string; name: string; reorder_level: number; is_active: boolean;
      category: { name: string } | null; brand: { name: string } | null; unit: { symbol: string } | null } | null;
    branch: { name: string; code: string } | null;
  };
  let list = (rows ?? []) as unknown as Row[];
  if (low) list = list.filter((r) => Number(r.quantity) <= Number(r.product?.reorder_level ?? 0));

  const totalValue = list.reduce((s, r) => s + Number(r.stock_value), 0);

  return (
    <div>
      <PageHeader
        title="Current Stock"
        description="Live quantity on hand by branch, from the stock-movement ledger."
      />
      <ListToolbar
        searchValue={q}
        searchPlaceholder="Search SKU or name..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branch, width: "w-[180px]",
            options: ctx.branches.map((b) => ({ value: b.id, label: `${b.name} (${b.code})` })) },
          { name: "low", placeholder: "All stock", value: low ? "1" : "",
            options: [{ value: "1", label: "Low stock only" }] },
        ]}
      />

      {list.length === 0 ? (
        <EmptyState title="No stock records" description="Post an opening balance or a purchase to build stock." />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">In transit</TableHead>
                {showCost && <TableHead className="text-right">Avg cost</TableHead>}
                {showCost && <TableHead className="text-right">Value</TableHead>}
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => {
                const lowStock = Number(r.quantity) <= Number(r.product?.reorder_level ?? 0);
                return (
                  <ClickableRow key={r.id} href={`/inventory/kardex?product=${r.product_id}&branch=${r.branch_id}`}>
                    <TableCell className="font-mono text-xs">{r.product?.sku}</TableCell>
                    <TableCell>
                      <div className="font-medium">{r.product?.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[r.product?.category?.name, r.product?.brand?.name].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{r.branch?.name ?? r.branch?.code}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQuantity(r.quantity)} {r.product?.unit?.symbol ?? ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {Number(r.qty_in_transit) > 0 ? formatQuantity(r.qty_in_transit) : "—"}
                    </TableCell>
                    {showCost && <TableCell className="text-right tabular-nums">{formatMoney(r.avg_unit_cost)}</TableCell>}
                    {showCost && <TableCell className="text-right tabular-nums">{formatMoney(r.stock_value)}</TableCell>}
                    <TableCell>
                      {Number(r.quantity) < 0 ? (
                        <Badge variant="destructive">Negative</Badge>
                      ) : lowStock ? (
                        <Badge variant="warning">Low</Badge>
                      ) : (
                        <StatusBadge active={r.product?.is_active ?? true} />
                      )}
                    </TableCell>
                  </ClickableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {showCost && list.length > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Total stock value (shown rows): <span className="font-semibold text-foreground tabular-nums">{formatMoney(totalValue)}</span>
        </p>
      )}
    </div>
  );
}
