import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { flattenProducts } from "@/lib/products";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { formatQuantity, formatDate } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PromotionsManager, type PromotionRow } from "./promotions-manager";

export const metadata: Metadata = { title: "Sales Promotions" };

export default async function SalesPromotionsPage() {
  await requirePermissionPage("promotions.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();

  const [{ data: promos }, { data: products }, { data: rewards }] = await Promise.all([
    admin.from("sales_promotions")
      .select("id, name, product_id, min_quantity, free_quantity, repeat_per_multiple, reward_timing, starts_on, ends_on, is_active, product:products(sku, name)")
      .eq("company_id", ctx.companyId).order("is_active", { ascending: false }).order("created_at", { ascending: false }),
    admin.from("products").select("id, sku, barcode, name, selling_price, tax_code_id, track_inventory, category:product_categories(name), brand:brands(name)")
      .eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("promotion_rewards")
      .select("id, quantity, created_at, customer:customers(name), product:products(sku, name), promotion:sales_promotions(name), earned:sales!promotion_rewards_earned_sale_id_fkey(id, document_number)")
      .eq("company_id", ctx.companyId).eq("status", "available").order("created_at", { ascending: false }).limit(200),
  ]);

  const rows = (promos ?? []).map((p) => {
    const pr = p as unknown as PromotionRow & { product: { sku: string; name: string } | null };
    return { ...pr, min_quantity: Number(pr.min_quantity), free_quantity: Number(pr.free_quantity), product_label: pr.product ? `${pr.product.sku} — ${pr.product.name}` : "—" };
  });
  const owed = (rewards ?? []) as unknown as Array<{
    id: string; quantity: number; created_at: string;
    customer: { name: string } | null; product: { sku: string; name: string } | null;
    promotion: { name: string } | null; earned: { id: string; document_number: string | null } | null;
  }>;

  return (
    <div className="space-y-6">
      <PageHeader title="Sales Promotions" description="Free goods for customers who buy enough of a product in one order. Walk-in customers never qualify." />

      <PromotionsManager rows={rows} products={flattenProducts(products)} canManage={can(ctx.user, "promotions.manage")} />

      <div>
        <h2 className="mb-2 text-sm font-semibold">Free goods owed to customers (next order)</h2>
        {owed.length === 0 ? (
          <Card><CardContent className="p-5 text-sm text-muted-foreground">No free goods are waiting for a next order.</CardContent></Card>
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Earned</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Free quantity</TableHead>
                  <TableHead>Promotion</TableHead>
                  <TableHead>From sale</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {owed.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm">{formatDate(r.created_at.slice(0, 10))}</TableCell>
                    <TableCell className="text-sm">{r.customer?.name}</TableCell>
                    <TableCell className="text-sm">{r.product ? `${r.product.sku} — ${r.product.name}` : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(r.quantity)}</TableCell>
                    <TableCell className="text-sm">{r.promotion?.name}</TableCell>
                    <TableCell className="text-sm">
                      {r.earned ? <Link href={`/sales/${r.earned.id}`} className="text-primary hover:underline">{r.earned.document_number}</Link> : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
