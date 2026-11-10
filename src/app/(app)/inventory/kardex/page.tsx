import type { Metadata } from "next";
import { MaybeClickableRow } from "@/components/common/clickable-row";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { ListToolbar } from "@/components/common/list-toolbar";
import { formatMoney, formatQuantity, formatDateTime } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Kardex" };
const PAGE = 40;

const TYPE_LABEL: Record<string, string> = {
  opening: "Opening", sale: "Sale", sale_void: "Sale void", sales_return: "Return",
  sales_return_void: "Return void", adjustment_increase: "Adj +", adjustment_decrease: "Adj −",
  adjustment_void: "Adj void", transfer_out: "Transfer out", transfer_in: "Transfer in",
  transfer_void: "Transfer void", purchase: "Purchase", purchase_return: "Purchase return",
};

type SP = Promise<Record<string, string | string[] | undefined>>;

/** The page that shows the document behind a stock movement (null when there is none). */
function sourceHref(type: string, id: string | null): string | null {
  if (!id) return null;
  switch (type) {
    case "sale": return `/sales/${id}`;
    case "purchase": return `/purchases/${id}`;
    case "stock_transfer": case "stock_transfer_void": return `/inventory/transfers/${id}`;
    case "rebag_order": return `/inventory/rebagging/${id}`;
    case "import_shipment": return `/imports/${id}`;
    case "cost_invoice": return "/imports/cost-invoices";
    case "stock_adjustment": return "/inventory/adjustments";
    case "inventory_opening": case "opening": return "/inventory/opening-balances";
    default: return null;
  }
}

export default async function KardexPage(props: { searchParams: SP }) {
  await requirePermissionPage("inventory.view_kardex");
  const ctx = await getActiveContext();
  const showCost = can(ctx.user, "inventory.view_cost");
  const admin = createAdminClient();

  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const branch = typeof sp.branch === "string" ? sp.branch : "";
  const type = typeof sp.type === "string" ? sp.type : "";
  // One product (opened from Current Stock).
  const product = typeof sp.product === "string" && /^[0-9a-f-]{36}$/i.test(sp.product) ? sp.product : "";
  const page = typeof sp.page === "string" ? Math.max(1, parseInt(sp.page, 10) || 1) : 1;
  const from = (page - 1) * PAGE, to = from + PAGE - 1;

  let productIds: string[] | null = null;
  if (q) {
    const { data } = await admin.from("products").select("id")
      .eq("company_id", ctx.companyId).or(`sku.ilike.%${q}%,name.ilike.%${q}%`);
    productIds = (data ?? []).map((p) => p.id);
    if (!productIds.length) productIds = ["00000000-0000-0000-0000-000000000000"];
  }

  let query = admin.from("stock_movements")
    .select("id, created_at, movement_type, source_type, source_id, source_number, qty_in, qty_out, unit_cost, movement_value, balance_qty, avg_cost_after, balance_value, branch:branches(code, name), product:products(sku, name)", { count: "exact" })
    .eq("company_id", ctx.companyId)
    .order("created_at", { ascending: false })
    .range(from, to);
  if (branch) query = query.eq("branch_id", branch);
  else if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  if (type) query = query.eq("movement_type", type);
  if (productIds) query = query.in("product_id", productIds);
  if (product) query = query.eq("product_id", product);
  const { data: productRow } = product
    ? await admin.from("products").select("sku, name").eq("id", product).eq("company_id", ctx.companyId).maybeSingle()
    : { data: null as { sku: string; name: string } | null };

  const { data, count } = await query;
  const rows = (data ?? []) as unknown as Array<{
    id: string; created_at: string; movement_type: string; source_type: string; source_id: string | null;
    source_number: string | null; qty_in: number; qty_out: number; unit_cost: number; movement_value: number;
    balance_qty: number; avg_cost_after: number; balance_value: number;
    branch: { code: string; name: string } | null; product: { sku: string; name: string } | null;
  }>;
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div>
      <PageHeader title="Kardex" description="Immutable stock-movement ledger. Rows cannot be edited." />
      {productRow && (
        <p className="mb-3 text-sm">Showing <span className="font-medium">{productRow.sku} — {productRow.name}</span>{" "}
          <Link className="text-primary hover:underline" href={`/inventory/kardex${branch ? `?branch=${branch}` : ""}`}>Show all products</Link></p>
      )}
      <ListToolbar
        searchValue={q}
        searchPlaceholder="Search product SKU or name..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branch, width: "w-[170px]",
            options: ctx.branches.map((b) => ({ value: b.id, label: b.name })) },
          { name: "type", placeholder: "All types", value: type, width: "w-[160px]",
            options: Object.entries(TYPE_LABEL).map(([v, l]) => ({ value: v, label: l })) },
        ]}
      />

      {rows.length === 0 ? (
        <EmptyState title="No movements found" />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Document</TableHead>
                <TableHead className="text-right">In</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                {showCost && <TableHead className="text-right">Unit cost</TableHead>}
                {showCost && <TableHead className="text-right">Stock value</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                return (
                <MaybeClickableRow key={r.id} href={sourceHref(r.source_type, r.source_id)}>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatDateTime(r.created_at)}</TableCell>
                  <TableCell className="min-w-[8rem] text-sm">{r.branch?.name ?? r.branch?.code}</TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">{r.product?.sku}</div>
                    <div className="text-xs text-muted-foreground">{r.product?.name}</div>
                  </TableCell>
                  <TableCell><Badge variant="secondary" className="text-[11px]">{TYPE_LABEL[r.movement_type] ?? r.movement_type}</Badge></TableCell>
                  <TableCell className="font-mono text-xs">{r.source_number ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-success">{Number(r.qty_in) > 0 ? formatQuantity(r.qty_in) : ""}</TableCell>
                  <TableCell className="text-right tabular-nums text-destructive">{Number(r.qty_out) > 0 ? formatQuantity(r.qty_out) : ""}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatQuantity(r.balance_qty)}</TableCell>
                  {showCost && <TableCell className="text-right tabular-nums">{formatMoney(r.unit_cost)}</TableCell>}
                  {showCost && <TableCell className="text-right tabular-nums">{formatMoney(r.balance_value)}</TableCell>}
                </MaybeClickableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {total > PAGE && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>{from + 1}–{Math.min(page * PAGE, total)} of {total}</span>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" disabled={page <= 1}>
              <Link href={`/inventory/kardex?${new URLSearchParams({ ...(q && { q }), ...(branch && { branch }), ...(type && { type }), page: String(page - 1) })}`}><ChevronLeft className="h-4 w-4" /> Prev</Link>
            </Button>
            <span>Page {page} of {totalPages}</span>
            <Button asChild variant="outline" size="sm" disabled={page >= totalPages}>
              <Link href={`/inventory/kardex?${new URLSearchParams({ ...(q && { q }), ...(branch && { branch }), ...(type && { type }), page: String(page + 1) })}`}>Next <ChevronRight className="h-4 w-4" /></Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
