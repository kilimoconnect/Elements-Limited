import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { DocStatusBadge, PayStatusBadge, saleStatus } from "@/components/common/doc-status-badge";
import { AttachmentsPanel } from "@/components/common/attachments-panel";
import { formatMoney, formatQuantity, formatDate, formatDateTime } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { SaleActions } from "./sale-actions";

export const metadata: Metadata = { title: "Sale" };
type Params = Promise<{ id: string }>;

export default async function SaleDetailPage(props: { params: Params }) {
  await requirePermissionPage("sales.view");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();
  const showCost = can(ctx.user, "sales.view_cost");

  const { data: sale } = await admin.from("sales")
    .select("*, customer:customers(code,name,phone,address,tin), branch:branches(name,code)")
    .eq("id", id).maybeSingle();
  if (!sale || sale.company_id !== ctx.companyId) notFound();

  const [{ data: lines }, { data: payments }, { data: receipts }, { data: returns }] = await Promise.all([
    admin.from("sale_lines").select("*").eq("sale_id", id).order("line_no"),
    admin.from("sale_payments").select("amount, reference, payment_date, account:payment_accounts(name)").eq("sale_id", id),
    admin.from("customer_receipt_allocations").select("amount, receipt:customer_receipts(document_number, document_date, document_status, payment_account:payment_accounts(name))").eq("sale_id", id),
    admin.from("sales_returns").select("id, document_number, document_date, total, refund_amount, document_status").eq("sale_id", id).order("created_at", { ascending: false }),
  ]);

  const people = [sale.submitted_by, sale.approved_by, sale.rejected_by].filter(Boolean) as string[];
  const { data: profiles } = people.length
    ? await admin.from("user_profiles").select("id, full_name, email").in("id", people)
    : { data: [] as { id: string; full_name: string | null; email: string }[] };
  const nameOf = (uid: string | null) => {
    const p = (profiles ?? []).find((x) => x.id === uid);
    return p ? (p.full_name || p.email) : "—";
  };

  const s = sale as Record<string, unknown> as {
    approval_status: string; submitted_by: string | null; submitted_at: string | null;
    approved_by: string | null; approved_at: string | null; rejected_by: string | null; rejected_at: string | null;
    rejection_reason: string | null; branch_id: string;
    document_number: string | null; document_status: string; payment_status: string; document_date: string;
    due_date: string | null; grand_total: number; net_total: number; tax_total: number; discount_total: number;
    subtotal: number; amount_paid: number; outstanding: number; cogs_total: number; void_reason: string | null;
    customer_id: string; customer: { code: string; name: string; phone: string | null; address: string | null; tin: string | null } | null;
    branch: { name: string; code: string } | null;
  };
  const ll = (lines ?? []) as unknown as Array<{
    id: string; description: string; quantity: number; unit_price: number; discount: number;
    tax_name: string | null; tax_rate: number; net_amount: number; tax_amount: number; line_total: number;
    unit_cost: number; cogs: number;
  }>;
  const gp = Number(s.net_total) - Number(s.cogs_total);
  const status = saleStatus(s.document_status, s.approval_status);
  const inMyBranch = ctx.user.isOwner || ctx.user.branchIds.includes(s.branch_id);

  return (
    <div>
      <PageHeader
        title={s.document_number ?? "Sales order"}
        description={`${s.branch?.name} · ${formatDate(s.document_date)}`}
        actions={
          <SaleActions id={id} status={s.document_status} approvalStatus={s.approval_status} outstanding={Number(s.outstanding)} customerId={s.customer_id}
            canEdit={inMyBranch && can(ctx.user, "sales.edit_draft")} canSubmit={inMyBranch && can(ctx.user, "sales.create")}
            canApprove={inMyBranch && can(ctx.user, "sales.approve")} canVoid={can(ctx.user, "transactions.void")}
            canDelete={can(ctx.user, "transactions.delete_draft")} canReceive={can(ctx.user, "sales.receive_payment")}
            canReturn={can(ctx.user, "sales.create_return")} />
        }
      />

      {status === "rejected" && s.rejection_reason && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span className="font-semibold">Rejected by {nameOf(s.rejected_by)}:</span> {s.rejection_reason}
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card><CardContent className="space-y-1 p-5 text-sm">
          <p className="text-xs uppercase text-muted-foreground">Customer</p>
          <p className="font-medium">{s.customer?.name}</p>
          <p className="text-muted-foreground">{s.customer?.phone ?? ""}</p>
          {s.customer?.tin && <p className="text-muted-foreground">TIN: {s.customer.tin}</p>}
        </CardContent></Card>
        <Card><CardContent className="space-y-2 p-5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Status</span><DocStatusBadge status={status} /></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Payment</span><PayStatusBadge status={s.payment_status} /></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Due date</span><span>{s.due_date ? formatDate(s.due_date) : "—"}</span></div>
          {s.void_reason && <div className="flex justify-between"><span className="text-muted-foreground">Void reason</span><span>{s.void_reason}</span></div>}
        </CardContent></Card>
        <Card><CardContent className="space-y-1.5 p-5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Net</span><span className="tabular-nums">{formatMoney(s.net_total)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="tabular-nums">{formatMoney(s.tax_total)}</span></div>
          <div className="flex justify-between font-semibold"><span>Total</span><span className="tabular-nums">{formatMoney(s.grand_total)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Paid</span><span className="tabular-nums">{formatMoney(s.amount_paid)}</span></div>
          <div className="flex justify-between font-medium"><span>Outstanding</span><span className="tabular-nums">{formatMoney(s.outstanding)}</span></div>
          {showCost && s.document_status === "posted" && (
            <>
              <div className="mt-1 flex justify-between border-t border-border pt-1"><span className="text-muted-foreground">COGS</span><span className="tabular-nums">{formatMoney(s.cogs_total)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Gross profit</span><span className="tabular-nums">{formatMoney(gp)}</span></div>
            </>
          )}
        </CardContent></Card>
      </div>

      <Card className="mb-4">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Disc</TableHead>
                <TableHead>Tax</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="text-right">Total</TableHead>
                {showCost && <TableHead className="text-right">Cost</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {ll.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.description}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(l.quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.unit_price)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.discount)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{l.tax_name ? `${l.tax_name} (${l.tax_rate}%)` : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.net_amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.line_total)}</TableCell>
                  {showCost && <TableCell className="text-right tabular-nums">{formatMoney(l.cogs)}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card><CardContent className="p-5">
          <h3 className="mb-2 text-sm font-semibold">Payments & receipts</h3>
          <div className="space-y-1 text-sm">
            {(payments ?? []).map((p, i) => (
              <div key={`p${i}`} className="flex justify-between"><span className="text-muted-foreground">{(p as unknown as { account: { name: string } | null }).account?.name} · {formatDate((p as unknown as { payment_date: string }).payment_date)}</span><span className="tabular-nums">{formatMoney((p as unknown as { amount: number }).amount)}</span></div>
            ))}
            {(receipts ?? []).map((r, i) => {
              const rec = (r as unknown as { receipt: { document_number: string | null; document_status: string; payment_account: { name: string } | null } | null }).receipt;
              if (!rec || rec.document_status !== "posted") return null;
              return <div key={`r${i}`} className="flex justify-between"><span className="text-muted-foreground">Receipt {rec.document_number} · {rec.payment_account?.name}</span><span className="tabular-nums">{formatMoney((r as { amount: number }).amount)}</span></div>;
            })}
            {(payments ?? []).length === 0 && (receipts ?? []).length === 0 && <p className="text-muted-foreground">No payments recorded.</p>}
          </div>
        </CardContent></Card>

        <Card><CardContent className="p-5">
          <h3 className="mb-2 text-sm font-semibold">Returns</h3>
          {(returns ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No returns.</p> : (
            <div className="space-y-1 text-sm">
              {(returns ?? []).map((r) => {
                const rr = r as { id: string; document_number: string | null; document_date: string; total: number; document_status: string };
                return <div key={rr.id} className="flex justify-between"><span className="text-muted-foreground">{rr.document_number} · {formatDate(rr.document_date)} · <DocStatusBadge status={rr.document_status} /></span><span className="tabular-nums">{formatMoney(rr.total)}</span></div>;
              })}
            </div>
          )}
        </CardContent></Card>

        <Card><CardContent className="p-5">
          <h3 className="mb-2 text-sm font-semibold">Approval</h3>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Submitted</span>
              <span>{s.submitted_at ? `${nameOf(s.submitted_by)} · ${formatDateTime(s.submitted_at)}` : "Not yet"}</span></div>
            {s.approved_at && (
              <div className="flex justify-between"><span className="text-muted-foreground">Approved</span>
                <span>{nameOf(s.approved_by)} · {formatDateTime(s.approved_at)}</span></div>
            )}
            {s.rejected_at && s.approval_status === "rejected" && (
              <div className="flex justify-between"><span className="text-muted-foreground">Rejected</span>
                <span>{nameOf(s.rejected_by)} · {formatDateTime(s.rejected_at)}</span></div>
            )}
          </div>
        </CardContent></Card>

        <Card><CardContent className="p-5">
          <h3 className="mb-2 text-sm font-semibold">Proof of payment & documents</h3>
          <AttachmentsPanel ownerType="sale" ownerId={id} categories={["proof_of_payment", "other"]} />
        </CardContent></Card>
      </div>
    </div>
  );
}
