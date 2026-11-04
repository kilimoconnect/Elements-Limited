import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { postExpense, deleteExpenseDraft, voidExpense } from "@/lib/expenses/actions";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListToolbar } from "@/components/common/list-toolbar";
import { DocStatusBadge, PayStatusBadge } from "@/components/common/doc-status-badge";
import { TxnActions } from "@/components/common/txn-actions";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClickableRow } from "@/components/common/clickable-row";

export const metadata: Metadata = { title: "Expense History" };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function ExpenseHistoryPage(props: { searchParams: SP }) {
  await requirePermissionPage("expenses.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canPost = can(ctx.user, "expenses.post");
  const canOwner = can(ctx.user, "transactions.void");
  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const status = typeof sp.status === "string" ? sp.status : "";

  let query = admin.from("expenses")
    .select("id, document_number, document_date, net_total, tax_total, grand_total, amount_paid, outstanding, payment_status, document_status, category:expense_categories(name), supplier:suppliers(name), branch:branches(code)")
    .eq("company_id", ctx.companyId).order("created_at", { ascending: false }).limit(100);
  if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  if (status) query = query.eq("document_status", status);
  if (q) query = query.or(`document_number.ilike.%${q}%,reference.ilike.%${q}%`);
  const rows = ((await query).data ?? []) as unknown as Array<{ id: string; document_number: string | null; document_date: string; net_total: number; tax_total: number; grand_total: number; amount_paid: number; outstanding: number; payment_status: string; document_status: string; category: { name: string } | null; supplier: { name: string } | null; branch: { code: string } | null }>;

  return (
    <div>
      <PageHeader title="Expense History" actions={<Button asChild><Link href="/expenses/new">New Expense</Link></Button>} />
      <ListToolbar searchValue={q} searchPlaceholder="Search expense no / reference..."
        selects={[{ name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [{ value: "draft", label: "Draft" }, { value: "posted", label: "Posted" }, { value: "voided", label: "Voided" }] }]} />
      {rows.length === 0 ? <EmptyState title="No expenses found" /> : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Document</TableHead><TableHead>Category</TableHead><TableHead>Payee</TableHead><TableHead className="text-right">Total</TableHead><TableHead className="text-right">Outstanding</TableHead><TableHead>Payment</TableHead><TableHead>Status</TableHead><TableHead className="w-10 text-right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <ClickableRow key={r.id} href={`/expenses/${r.id}`}>
                  <TableCell className="text-sm">{formatDate(r.document_date)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.document_number ?? <Badge variant="muted">Draft</Badge>}</TableCell>
                  <TableCell className="text-sm">{r.category?.name}</TableCell>
                  <TableCell className="text-sm">{r.supplier?.name ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.grand_total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.outstanding)}</TableCell>
                  <TableCell><PayStatusBadge status={r.payment_status} /></TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right">
                    <TxnActions id={r.id} status={r.document_status} canPost={canPost} canOwner={canOwner}
                      postAction={postExpense} deleteAction={deleteExpenseDraft} voidAction={voidExpense} afterDeletePush="/expenses/history"
                      extraItems={[{ label: "View", href: `/expenses/${r.id}` }, ...(r.document_status === "posted" && Number(r.outstanding) > 0 && can(ctx.user, "purchases.record_payment") ? [{ label: "Record payment", href: `/purchases/supplier-payments/new` }] : [])]} />
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
