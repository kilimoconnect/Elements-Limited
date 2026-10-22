import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { ActiveContext } from "@/lib/context";
import type { RebagOptions } from "./rebag-form";

/** Everything the rebagging form needs, scoped to the active company and the user's branches. */
export async function loadRebagOptions(ctx: ActiveContext): Promise<RebagOptions> {
  const admin = createAdminClient();
  const branches = ctx.branches.filter((b) => ctx.user.isOwner || ctx.user.branchIds.includes(b.id));
  const branchIds = branches.map((b) => b.id);
  const [{ data: products }, { data: lots }, { data: balances }, { data: categories }, { data: shipments }] = await Promise.all([
    admin.from("products").select("id, sku, name, stock_role, net_weight_kg, bulk_product_id, rebag_loss_tolerance_pct")
      .eq("company_id", ctx.companyId).eq("is_active", true).in("stock_role", ["bulk", "packaged", "packaging_material"]).order("name"),
    admin.from("stock_lot_balances").select("branch_id, product_id, quantity, lot:stock_lots(id, lot_code, origin_type)")
      .eq("company_id", ctx.companyId).gt("quantity", 0).in("branch_id", branchIds.length ? branchIds : ["00000000-0000-0000-0000-000000000000"]),
    admin.from("stock_balances").select("branch_id, product_id, quantity, avg_unit_cost")
      .eq("company_id", ctx.companyId).in("branch_id", branchIds.length ? branchIds : ["00000000-0000-0000-0000-000000000000"]),
    admin.from("cost_categories").select("id, code, name, inventory_treatment, allocation_basis")
      .eq("company_id", ctx.companyId).eq("is_active", true).eq("applies_to_rebagging", true).eq("is_goods_value", false).order("code"),
    admin.from("import_shipments").select("id, document_number, logistics_status").eq("company_id", ctx.companyId)
      .not("logistics_status", "in", "(cancelled,draft)").order("created_at", { ascending: false }).limit(200),
  ]);
  type P = { id: string; sku: string; name: string; stock_role: string; net_weight_kg: number | null; bulk_product_id: string | null; rebag_loss_tolerance_pct: number };
  const ps = (products ?? []) as P[];
  return {
    branches: branches.map((b) => ({ id: b.id, label: `${b.code} — ${b.name}` })),
    bulkProducts: ps.filter((p) => p.stock_role === "bulk").map((p) => ({ id: p.id, label: `${p.sku} — ${p.name}`, tolerance: Number(p.rebag_loss_tolerance_pct) })),
    packagedProducts: ps.filter((p) => p.stock_role === "packaged" && p.bulk_product_id && Number(p.net_weight_kg) > 0)
      .map((p) => ({ id: p.id, label: `${p.sku} — ${p.name}`, bulkId: p.bulk_product_id!, kg: Number(p.net_weight_kg) })),
    materials: ps.filter((p) => p.stock_role === "packaging_material").map((p) => ({ id: p.id, label: `${p.sku} — ${p.name}` })),
    lots: ((lots ?? []) as unknown as { branch_id: string; product_id: string; quantity: number; lot: { id: string; lot_code: string | null } | null }[])
      .filter((l) => l.lot).map((l) => ({ id: l.lot!.id, branchId: l.branch_id, productId: l.product_id, label: l.lot!.lot_code ?? "batch", kg: Number(l.quantity) })),
    stock: ((balances ?? []) as { branch_id: string; product_id: string; quantity: number; avg_unit_cost: number }[])
      .map((b) => ({ branchId: b.branch_id, productId: b.product_id, qty: Number(b.quantity), avg: Number(b.avg_unit_cost) })),
    categories: (categories ?? []).map((c) => ({ id: c.id, label: `${c.code} — ${c.name}`, capitalise: c.inventory_treatment === "capitalize",
      basis: c.allocation_basis === "net_weight" ? "weight" : c.allocation_basis })),
    shipments: (shipments ?? []).map((s) => ({ id: s.id, label: s.document_number ?? "—" })),
  };
}
