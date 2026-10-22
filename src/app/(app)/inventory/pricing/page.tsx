import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { type SP } from "@/lib/reports/period";
import { str } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ParamSelect } from "@/components/reports/report-tools";
import { formatDateTime, formatMoney } from "@/lib/format";
import { PricingCalculator } from "./pricing-calculator";

export const metadata: Metadata = { title: "Pricing" };
const N = (v: unknown) => Number(v ?? 0);

export default async function PricingPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("inventory.view_cost");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const branches = ctx.branches.filter((b) => ctx.user.isOwner || ctx.user.branchIds.includes(b.id));
  const branchId = str(sp, "branch") || (branches.some((b) => b.id === ctx.branchId) ? ctx.branchId! : branches[0]?.id ?? "");
  const productId = str(sp, "product");
  const admin = createAdminClient();
  const { data: stock } = await admin.from("stock_balances").select("product_id, quantity, avg_unit_cost, product:products(sku, name)")
    .eq("company_id", ctx.companyId).eq("branch_id", branchId || "00000000-0000-0000-0000-000000000000").gt("quantity", 0);
  const options = ((stock ?? []) as unknown as { product_id: string; product: { sku: string; name: string } | null }[])
    .map((s) => ({ id: s.product_id, label: `${s.product?.sku} — ${s.product?.name}` })).sort((a, b) => a.label.localeCompare(b.label));
  let body = <EmptyState title="Choose a product with stock at this branch" />;
  if (productId && branchId && branches.some((b) => b.id === branchId)) {
    const [{ data: p }, { data: bal }, { data: all }, { data: history }] = await Promise.all([
      admin.from("products").select("id, company_id, sku, name, stock_role, net_weight_kg, selling_price, tax:tax_codes(name, rate, is_inclusive)").eq("id", productId).maybeSingle(),
      admin.from("stock_balances").select("quantity, avg_unit_cost").eq("branch_id", branchId).eq("product_id", productId).maybeSingle(),
      admin.from("stock_balances").select("branch_id, quantity, avg_unit_cost").eq("company_id", ctx.companyId).eq("product_id", productId).gt("quantity", 0),
      admin.from("product_price_changes").select("old_price, new_price, basis, reason, changed_at").eq("product_id", productId).order("changed_at", { ascending: false }).limit(10),
    ]);
    if (p && p.company_id === ctx.companyId) {
      const kgu = p.stock_role === "bulk" ? 1 : p.net_weight_kg ? N(p.net_weight_kg) : null;
      const branchCosts = ((all ?? []) as { branch_id: string; quantity: number; avg_unit_cost: number }[])
        .filter((r) => branches.some((b) => b.id === r.branch_id))
        .map((r) => { const b = branches.find((x) => x.id === r.branch_id)!; return { branchId: r.branch_id, label: `${b.code} — ${b.name}`, qty: N(r.quantity), cost: N(r.avg_unit_cost) }; })
        .sort((a, b) => a.label.localeCompare(b.label));
      const tax = p.tax as unknown as { name: string; rate: number; is_inclusive: boolean } | null;
      body = (
        <div className="space-y-4">
          <PricingCalculator productId={p.id} branchId={branchId} canApprove={ctx.user.isOwner}
            product={{ sku: p.sku, name: p.name, kgPerUnit: kgu, currentPrice: N(p.selling_price), qty: N(bal?.quantity) }}
            inventoryCost={N(bal?.avg_unit_cost)} branchCosts={branchCosts}
            tax={{ name: tax?.name ?? "No tax code", rate: N(tax?.rate), inclusive: !!tax?.is_inclusive }} />
          <Card><CardContent className="p-5 text-sm">
            <h3 className="mb-2 font-semibold">Approved price history</h3>
            {(history ?? []).length === 0 ? <p className="text-muted-foreground">No changes recorded through pricing yet.</p> :
              ((history ?? []) as { old_price: number; new_price: number; basis: Record<string, unknown>; reason: string | null; changed_at: string }[]).map((h, i) => (
                <p key={i} className="border-b border-border py-1 last:border-0">{formatDateTime(h.changed_at)} · TZS {formatMoney(N(h.old_price))} → <span className="font-semibold">{formatMoney(N(h.new_price))}</span>
                  <span className="text-xs text-muted-foreground"> · {String(h.basis.mode ?? "")} {String(h.basis.ratePct ?? "")}% on inventory cost {formatMoney(N(h.basis.inventoryCost ?? h.basis.pricingCost))}{h.reason && ` · ${h.reason}`}</span></p>
              ))}
          </CardContent></Card>
        </div>
      );
    }
  }
  return (
    <div>
      <PageHeader title="Pricing" description="Suggest a selling price from the branch's inventory cost. Each branch has its own cost: what the goods cost plus the import, rebagging and transfer costs of bringing them there." />
      <div className="mb-4 flex flex-wrap gap-2">
        <ParamSelect param="branch" value={branchId} placeholder="Branch" options={branches.map((b) => ({ id: b.id, label: `${b.code} — ${b.name}` }))} />
        <ParamSelect param="product" value={productId} placeholder="Product" options={options} />
      </div>
      {body}
    </div>
  );
}
