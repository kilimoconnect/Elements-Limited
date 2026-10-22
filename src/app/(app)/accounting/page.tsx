import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconciliationControls } from "@/lib/reports/subledger";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatMoney, formatDate, todayISO } from "@/lib/format";

export const metadata: Metadata = { title: "Accounting Overview" };

export default async function AccountingOverview() {
  await requirePermissionPage("accounting.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const today = todayISO();

  const { data: period } = await admin.from("accounting_periods").select("name, status, start_date, end_date")
    .eq("company_id", ctx.companyId).lte("start_date", today).gte("end_date", today).maybeSingle();
  const controls = can(ctx.user, "accounting.view_control_accounts") ? await reconciliationControls(ctx.companyId, today) : [];
  const allReconciled = controls.every((c) => c.status === "Reconciled");

  const links = [
    { href: "/accounting/journals", label: "Journal Entries", perm: "accounting.view_journals" },
    { href: "/accounting/journals/new", label: "New Manual Journal", perm: "accounting.create_manual_journal" },
    { href: "/accounting/general-ledger", label: "General Ledger", perm: "accounting.view_general_ledger" },
    { href: "/accounting/trial-balance", label: "Trial Balance", perm: "accounting.view_trial_balance" },
    { href: "/accounting/reconciliation-controls", label: "Reconciliation Controls", perm: "accounting.view_control_accounts" },
    { href: "/accounting/opening-balances", label: "Opening Balances", perm: "accounting.manage_opening_balances" },
    { href: "/accounting/period-close", label: "Period Close", perm: "periods.view" },
  ].filter((l) => can(ctx.user, l.perm));

  return (
    <div>
      <PageHeader title="Accounting Overview" description="Journals, ledgers, controls and period management." />
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card><CardContent className="p-5">
          <p className="text-xs uppercase text-muted-foreground">Current period</p>
          <p className="text-lg font-semibold">{period?.name ?? "None"}</p>
          {period && <div className="mt-1 flex items-center gap-2"><Badge variant={period.status === "open" ? "success" : period.status === "locked" ? "destructive" : "muted"}>{period.status}</Badge><span className="text-xs text-muted-foreground">{formatDate(period.start_date)} → {formatDate(period.end_date)}</span></div>}
        </CardContent></Card>
        {controls.length > 0 && (
          <Card className="lg:col-span-2"><CardContent className="p-5">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs uppercase text-muted-foreground">Reconciliation status</p>
              {allReconciled ? <Badge variant="success">All reconciled</Badge> : <Badge variant="destructive">Differences found</Badge>}
            </div>
            <div className="space-y-1 text-sm">
              {controls.map((c) => (
                <div key={c.key} className="flex justify-between">
                  <span className="text-muted-foreground">{c.label}</span>
                  <span className="tabular-nums">{c.status === "Reconciled" ? <Badge variant="success">OK</Badge> : <span className="text-destructive">{formatMoney(c.difference)}</span>}</span>
                </div>
              ))}
            </div>
          </CardContent></Card>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {links.map((l) => (
          <Link key={l.href} href={l.href}><Card className="transition-colors hover:border-primary"><CardContent className="p-4 text-sm font-medium">{l.label}</CardContent></Card></Link>
        ))}
      </div>
    </div>
  );
}
