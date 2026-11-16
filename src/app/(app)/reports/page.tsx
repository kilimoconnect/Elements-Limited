import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = { title: "Financial Reports" };

const REPORTS: { href: string; title: string; desc: string; perm: string }[] = [
  { href: "/reports/profit-and-loss", title: "Profit & Loss", desc: "Revenue, cost of sales and expenses", perm: "reports.view_profit_loss" },
  { href: "/reports/balance-sheet", title: "Balance Sheet", desc: "Assets, liabilities and equity as of a date", perm: "reports.view_balance_sheet" },
  { href: "/reports/cash-flow", title: "Cash Flow", desc: "Cash movements by activity", perm: "reports.view_cash_flow" },
  { href: "/reports/vat", title: "VAT Report", desc: "Output and input VAT with reconciliation", perm: "reports.view_vat" },
  { href: "/reports/receivables-ageing", title: "Receivables Ageing", desc: "Customer balances by age bucket", perm: "reports.view_receivables" },
  { href: "/reports/payables-ageing", title: "Payables Ageing", desc: "Supplier balances by age bucket", perm: "reports.view_payables" },
  { href: "/reports/customer-statements", title: "Customer Statements", desc: "Statement of account for a customer", perm: "reports.view_receivables" },
  { href: "/reports/supplier-statements", title: "Supplier Statements", desc: "Statement of account for a supplier", perm: "reports.view_payables" },
  { href: "/reports/inventory-valuation", title: "Inventory Valuation", desc: "Stock value by product & branch", perm: "reports.view_inventory_valuation" },
  { href: "/reports/transfers", title: "Transfer Report", desc: "Stock moved between branches: loaded, received, in transit, losses and timing", perm: "inventory.transfer_view" },
];

export default async function ReportsIndex() {
  await requirePermissionPage("reports.view");
  const ctx = await getActiveContext();
  const items = REPORTS.filter((r) => can(ctx.user, r.perm));
  return (
    <div>
      <PageHeader title="Financial Reports" description="All reports are generated from posted journal entries." />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((r) => (
          <Link key={r.href} href={r.href}>
            <Card className="h-full transition-colors hover:border-primary"><CardContent className="p-5">
              <p className="font-medium">{r.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{r.desc}</p>
            </CardContent></Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
