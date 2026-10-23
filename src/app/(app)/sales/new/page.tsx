import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { flattenProducts } from "@/lib/products";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { loadPromotionPreview } from "@/lib/sales/promotion-data";
import { SaleForm } from "./sale-form";

export const metadata: Metadata = { title: "New Sales Order" };

export default async function NewSalePage() {
  await requirePermissionPage("sales.create");
  const ctx = await getActiveContext();
  const admin = createAdminClient();

  if (!ctx.branchId) {
    return (
      <div>
        <PageHeader title="New Sales Order" />
        <EmptyState title="No active branch" description="You need an assigned branch to create sales orders." />
      </div>
    );
  }

  const [{ data: products }, { data: taxCodes }, { data: accounts }, { data: customers }, { data: bals }] = await Promise.all([
    admin.from("products").select("id, sku, barcode, name, selling_price, tax_code_id, track_inventory, category:product_categories(name), brand:brands(name)").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("tax_codes").select("id, name, rate, is_inclusive").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("payment_accounts").select("id, code, name, branch_id").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("customers").select("id, code, name, is_protected").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("stock_balances").select("product_id, quantity").eq("company_id", ctx.companyId).eq("branch_id", ctx.branchId),
  ]);

  const promo = await loadPromotionPreview(ctx.companyId);
  const stock: Record<string, number> = {};
  for (const b of bals ?? []) stock[b.product_id] = Number(b.quantity);
  const branchAccounts = (accounts ?? []).filter((a) => !a.branch_id || a.branch_id === ctx.branchId);
  const walkIn = (customers ?? []).find((c) => c.is_protected);

  return (
    <div>
      <PageHeader title="New Sales Order" description={can(ctx.user, "sales.approve") ? "You approve your own orders: approving posts the sale." : "Attach proof of payment, then submit. The Branch Manager approves the order, which posts the sale."} />
      <SaleForm
        branchId={ctx.branchId}
        products={flattenProducts(products)}
        taxCodes={(taxCodes ?? []).map((t) => ({ ...t, rate: Number(t.rate) })) as never}
        accounts={branchAccounts as never}
        customers={(customers ?? []) as never}
        stock={stock}
        canViewCost={can(ctx.user, "sales.view_cost")}
        walkInId={walkIn?.id ?? null}
        canApprove={can(ctx.user, "sales.approve")}
        promotions={promo.rules}
        rewards={promo.rewards}
      />
    </div>
  );
}
