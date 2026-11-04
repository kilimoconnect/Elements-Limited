import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { can } from "@/lib/context";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClickableRow } from "@/components/common/clickable-row";

export const metadata: Metadata = { title: "Bank Reconciliation" };

export default async function ReconciliationListPage() {
  await requirePermissionPage("reconciliation.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const { data: rows } = await admin.from("bank_reconciliations")
    .select("id, statement_start, statement_end, statement_closing, status, account:payment_accounts(name)")
    .eq("company_id", ctx.companyId).order("created_at", { ascending: false }).limit(100);
  const list = (rows ?? []) as unknown as Array<{ id: string; statement_start: string; statement_end: string; statement_closing: number; status: string; account: { name: string } | null }>;
  const variant = (s: string) => s === "finalized" ? "success" : s === "reopened" ? "warning" : "muted";

  return (
    <div>
      <PageHeader title="Bank & Mobile-Money Reconciliation" description="Match statement lines to posted ERP entries."
        actions={can(ctx.user, "reconciliation.create") ? <Button asChild><Link href="/cash-and-banks/reconciliation/new">New Reconciliation</Link></Button> : null} />
      {list.length === 0 ? <EmptyState title="No reconciliations yet" /> : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Account</TableHead><TableHead>Period</TableHead><TableHead className="text-right">Closing</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Open</TableHead></TableRow></TableHeader>
            <TableBody>
              {list.map((r) => (
                <ClickableRow key={r.id} href={`/cash-and-banks/reconciliation/${r.id}`}>
                  <TableCell className="text-sm font-medium">{r.account?.name}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.statement_start)} → {formatDate(r.statement_end)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.statement_closing)}</TableCell>
                  <TableCell><Badge variant={variant(r.status)}>{r.status.replace("_", " ")}</Badge></TableCell>
                  <TableCell className="text-right"><Link href={`/cash-and-banks/reconciliation/${r.id}`} className="text-sm font-medium text-primary hover:underline">Open</Link></TableCell>
                </ClickableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
