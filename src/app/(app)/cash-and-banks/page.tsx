import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney } from "@/lib/format";
import { OverdraftButton } from "./overdraft-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClickableRow } from "@/components/common/clickable-row";

export const metadata: Metadata = { title: "Cash and Banks" };

export default async function CashAndBanksPage() {
  await requirePermissionPage("cash_accounts.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const showBal = can(ctx.user, "cash_accounts.view_balance");
  const showLedger = can(ctx.user, "cash_accounts.view_ledger");
  const isOwner = ctx.user.isOwner;

  const { data: accounts } = await admin.from("payment_accounts")
    .select("id, code, name, account_type, provider, allow_negative, overdraft_limit, is_active")
    .eq("company_id", ctx.companyId).order("code");

  const withBal = await Promise.all((accounts ?? []).map(async (a) => {
    let balance = 0;
    if (showBal) {
      const { data } = await admin.rpc("payment_account_balance", { p_pa: a.id });
      balance = Number(data ?? 0);
    }
    return { ...a, balance, available: balance + (a.allow_negative ? Number(a.overdraft_limit) : 0) };
  }));
  const totalBal = withBal.reduce((s, a) => s + a.balance, 0);

  return (
    <div>
      <PageHeader title="Cash and Banks" description="Balances are derived from posted journal entries — never edited directly." />
      {showBal && (
        <Card className="mb-4"><CardContent className="p-5">
          <p className="text-xs uppercase text-muted-foreground">Total cash & bank</p>
          <p className="text-2xl font-semibold tabular-nums">{formatMoney(totalBal)}</p>
        </CardContent></Card>
      )}
      {withBal.length === 0 ? <EmptyState title="No payment accounts" /> : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Account</TableHead><TableHead>Type</TableHead><TableHead>Provider</TableHead>
              {showBal && <TableHead className="text-right">Balance</TableHead>}
              {showBal && <TableHead className="text-right">Available</TableHead>}
              <TableHead>Status</TableHead><TableHead className="text-right">Ledger</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {withBal.map((a) => (
                <ClickableRow key={a.id} href={`/cash-and-banks/accounts/${a.id}`}>
                  <TableCell><div className="font-medium">{a.name}</div><div className="font-mono text-xs text-muted-foreground">{a.code}</div></TableCell>
                  <TableCell className="text-sm capitalize">{a.account_type.replace("_", " ")}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.provider ?? "—"}</TableCell>
                  {showBal && <TableCell className="text-right tabular-nums">{formatMoney(a.balance)}</TableCell>}
                  {showBal && <TableCell className="text-right tabular-nums text-muted-foreground">{formatMoney(a.available)}</TableCell>}
                  <TableCell><Badge variant={a.is_active ? "success" : "muted"}>{a.is_active ? "Active" : "Inactive"}</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-3">
                      {isOwner && <OverdraftButton account={{ id: a.id, name: a.name, allow_negative: a.allow_negative, overdraft_limit: Number(a.overdraft_limit) }} />}
                      {showLedger && <Link href={`/cash-and-banks/accounts/${a.id}`} className="text-sm font-medium text-primary hover:underline">Ledger</Link>}
                    </div>
                  </TableCell>
                </ClickableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
