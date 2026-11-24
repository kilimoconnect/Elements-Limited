import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { postExpense, deleteExpenseDraft, voidExpense } from "@/lib/expenses/actions";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { DocStatusBadge, PayStatusBadge } from "@/components/common/doc-status-badge";
import { TxnActions } from "@/components/common/txn-actions";
import { formatMoney, formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "Expense" };
type Params = Promise<{ id: string }>;

export default async function ExpenseDetail(props: { params: Params }) {
  await requirePermissionPage("expenses.view");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();
  const { data: exp } = await admin.from("expenses").select("*, category:expense_categories(name), supplier:suppliers(name), branch:branches(name)").eq("id", id).maybeSingle();
  if (!exp || exp.company_id !== ctx.companyId) notFound();
  const { data: payments } = await admin.from("expense_payments").select("amount, payment_date, account:payment_accounts(name)").eq("expense_id", id);
  const e = exp as Record<string, unknown> as { document_number: string | null; document_status: string; payment_status: string; document_date: string; description: string | null; reference: string | null; net_total: number; tax_total: number; grand_total: number; amount_paid: number; outstanding: number; void_reason: string | null; category: { name: string } | null; supplier: { name: string } | null; branch: { name: string } | null };

  return (
    <div>
      <PageHeader title={e.document_number ?? "Expense (draft)"} description={`${e.category?.name} · ${e.branch?.name} · ${formatDate(e.document_date)}`}
        actions={<TxnActions id={id} status={e.document_status} canPost={can(ctx.user, "expenses.post")} canOwner={can(ctx.user, "transactions.void")} postAction={postExpense} deleteAction={deleteExpenseDraft} voidAction={voidExpense} afterDeletePush="/expenses/history" />} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card><CardContent className="space-y-2 p-5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Status</span><DocStatusBadge status={e.document_status} /></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Payment</span>{e.document_status === "voided" ? <span className="text-muted-foreground">—</span> : <PayStatusBadge status={e.payment_status} />}</div>
          <div className="flex justify-between"><span className="text-muted-foreground">Payee</span><span>{e.supplier?.name ?? "—"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Reference</span><span>{e.reference ?? "—"}</span></div>
          {e.void_reason && <div className="flex justify-between"><span className="text-muted-foreground">Void reason</span><span>{e.void_reason}</span></div>}
        </CardContent></Card>
        <Card><CardContent className="space-y-1.5 p-5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Net</span><span className="tabular-nums">{formatMoney(e.net_total)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="tabular-nums">{formatMoney(e.tax_total)}</span></div>
          <div className="flex justify-between font-semibold"><span>Total</span><span className="tabular-nums">{formatMoney(e.grand_total)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Paid</span><span className="tabular-nums">{formatMoney(e.amount_paid)}</span></div>
          <div className="flex justify-between font-medium"><span>Outstanding</span><span className="tabular-nums">{e.document_status === "voided" ? "—" : formatMoney(e.outstanding)}</span></div>
        </CardContent></Card>
        <Card><CardContent className="p-5"><h3 className="mb-2 text-sm font-semibold">Payments</h3>
          {(payments ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No payments.</p> : <div className="space-y-1 text-sm">{(payments ?? []).map((p, i) => { const pp = p as unknown as { account: { name: string } | null; amount: number; payment_date: string }; return <div key={i} className="flex justify-between"><span className="text-muted-foreground">{pp.account?.name} · {formatDate(pp.payment_date)}</span><span className="tabular-nums">{formatMoney(pp.amount)}</span></div>; })}</div>}
          {e.description && <p className="mt-3 text-sm text-muted-foreground">{e.description}</p>}
        </CardContent></Card>
      </div>
    </div>
  );
}
