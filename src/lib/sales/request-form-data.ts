import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { flattenProducts } from "@/lib/products";
import { loadPromotionPreview } from "@/lib/sales/promotion-data";
import { customerAvailableFunds } from "@/lib/sales/fulfilment-data";

/** Everything the Sales Request form needs for one branch. */
export async function loadRequestFormData(companyId: string, branchId: string) {
  const admin = createAdminClient();
  const [{ data: products }, { data: taxCodes }, { data: accounts }, { data: customers }, { data: bals }, { data: open }] = await Promise.all([
    admin.from("products").select("id, sku, barcode, name, selling_price, tax_code_id, track_inventory, category:product_categories(name), brand:brands(name)").eq("company_id", companyId).eq("is_active", true).order("name"),
    admin.from("tax_codes").select("id, name, rate, is_inclusive").eq("company_id", companyId).eq("is_active", true).order("code"),
    admin.from("payment_accounts").select("id, code, name, branch_id").eq("company_id", companyId).eq("is_active", true).order("code"),
    admin.from("customers").select("id, code, name, is_protected").eq("company_id", companyId).eq("is_active", true).order("code"),
    admin.from("stock_balances").select("product_id, quantity").eq("company_id", companyId).eq("branch_id", branchId),
    admin.from("sales_order_lines").select("product_id, quantity, qty_dispatched, order:sales_orders!inner(branch_id, status)")
      .eq("track_inventory", true).eq("order.branch_id", branchId).in("order.status", ["approved", "in_fulfilment"]),
  ]);
  const onHand: Record<string, number> = {};
  for (const b of bals ?? []) onHand[b.product_id] = Number(b.quantity);
  const reserved: Record<string, number> = {};
  for (const l of open ?? []) reserved[l.product_id] = (reserved[l.product_id] ?? 0) + Math.max(Number(l.quantity) - Number(l.qty_dispatched), 0);
  const promo = await loadPromotionPreview(companyId);
  return {
    products: flattenProducts(products),
    taxCodes: (taxCodes ?? []).map((t) => ({ ...t, rate: Number(t.rate) })),
    accounts: (accounts ?? []).filter((a) => !a.branch_id || a.branch_id === branchId),
    customers: customers ?? [],
    onHand, reserved,
    funds: await customerAvailableFunds(admin, companyId),
    promotions: promo.rules, rewards: promo.rewards,
  };
}
