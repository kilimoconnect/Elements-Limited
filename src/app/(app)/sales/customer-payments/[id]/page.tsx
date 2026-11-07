import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Printer } from "lucide-react";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { AttachmentsPanel } from "@/components/common/attachments-panel";
import { ClickableRow } from "@/components/common/clickable-row";
import { Field } from "@/components/sales/sales-ui";
import { canSeeBranch, userNames, METHOD_LABEL } from "@/lib/sales/fulfilment-data";
import { formatMoney, formatDate, formatDateTime } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Customer Payment" };

/** One customer payment: what it paid, where it came from and its proof of payment. */
export default async function CustomerPaymentPage(props: { params: Promise<{ id: string }> }) {
  await requirePermissionPage("sales.view");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const admin = createAdminClient();
  const { data: r } = await admin.from("customer_receipts")
    .select("*, customer:customers(code, name, phone), branch:branches(code, name), account:payment_accounts(name)")
    .eq("id", id).maybeSingle();
  if (!r || r.company_id !== ctx.companyId || !canSeeBranch(ctx.user, r.branch_id)) notFound();

  const [{ data: allocs }, { data: reqPays }, { data: funds }, { data: refunds }, { data: avail }] = await Promise.all([
    admin.from("customer_receipt_allocations").select("amount, sale:sales(id, document_number, document_date, grand_total, shipment_id)").eq("receipt_id", id),
    admin.from("sales_request_payments").select("request:sales_requests(id, document_number, status, sales_order_id)").eq("receipt_id", id),
    admin.from("sales_order_funds").select("amount_committed, amount_applied, amount_released, order:sales_orders(id, document_number, status)").eq("receipt_id", id),
    admin.from("customer_advance_refunds").select("document_number, amount, refunded_at, reason").eq("receipt_id", id),
    r.receipt_kind === "advance" ? admin.rpc("customer_receipt_available", { p_receipt: id }) : Promise.resolve({ data: null }),
  ]);
  const nameOf = await userNames(admin, [r.created_by, r.posted_by, r.verified_by, r.voided_by]);
  type Alloc = { amount: number; sale: { id: string; document_number: string | null; document_date: string; grand_total: number; shipment_id: string | null } | null };
  type Rq = { request: { id: string; document_number: string | null; status: string; sales_order_id: string | null } | null };
  type Fund = { amount_committed: number; amount_applied: number; amount_released: number; order: { id: string; document_number: string; status: string } | null };
  const requests = ((reqPays ?? []) as unknown as Rq[]).map((x) => x.request).filter(Boolean) as NonNullable<Rq["request"]>[];
  const advance = r.receipt_kind === "advance";

  return (
    <div className="space-y-4">
      <Button asChild variant="outline" size="sm"><Link href="/sales/customer-payments"><ArrowLeft className="h-4 w-4" /> Back to customer payments</Link></Button>
      <PageHeader title={`Payment ${r.document_number ?? ""}`} description={`${r.customer?.name ?? ""} · ${formatDate(r.document_date)}`}
        actions={<div className="flex flex-wrap items-center gap-2">
          <DocStatusBadge status={r.document_status} />
          {advance && <Badge variant="default">Customer advance</Badge>}
          <Button asChild variant="outline" size="sm"><Link href={`/receipt/${r.id}`} target="_blank"><Printer className="h-4 w-4" /> Print receipt</Link></Button>
        </div>} />

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 sm:p-5">
          <Field label="Amount"><span className="text-base font-semibold tabular-nums">{formatMoney(r.amount)}</span></Field>
          <Field label="Customer">{r.customer?.code} — {r.customer?.name}</Field>
          <Field label="Received into">{r.account?.name}</Field>
          <Field label="Method">{r.payment_method ? (METHOD_LABEL[r.payment_method] ?? r.payment_method) : "—"}</Field>
          <Field label="Reference"><span className="font-mono">{r.reference ?? "—"}</span></Field>
          <Field label="Branch">{r.branch?.name}</Field>
          <Field label="Recorded">{nameOf(r.posted_by ?? r.created_by)}{r.posted_at ? `, ${formatDateTime(r.posted_at)}` : ""}</Field>
          {r.verified_by && <Field label="Verified by">{nameOf(r.verified_by)}{r.verified_at ? `, ${formatDateTime(r.verified_at)}` : ""}</Field>}
          {r.verification_basis && <div className="col-span-2 sm:col-span-4"><Field label="How it was verified">{r.verification_basis}</Field></div>}
          {advance && avail !== null && <Field label="Unused (customer credit)"><span className="tabular-nums">{formatMoney(Number(avail ?? 0))}</span></Field>}
          {r.notes && <div className="col-span-2 sm:col-span-4"><Field label="Notes">{r.notes}</Field></div>}
          {r.void_reason && <div className="col-span-2 sm:col-span-4"><Field label={`Voided by ${nameOf(r.voided_by)}`}>{r.void_reason}</Field></div>}
        </CardContent>
      </Card>

      {(allocs ?? []).length > 0 && (
        <Card><CardContent className="p-0">
          <p className="px-4 pt-4 text-sm font-medium sm:px-5">Invoices paid</p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Invoice</TableHead><TableHead>Date</TableHead><TableHead className="text-right">Invoice total</TableHead><TableHead className="text-right">Paid by this payment</TableHead></TableRow></TableHeader>
              <TableBody>{((allocs ?? []) as unknown as Alloc[]).map((a, i) => a.sale && (
                <ClickableRow key={i} href={`/sales/${a.sale.id}`}>
                  <TableCell className="font-mono text-xs">{a.sale.document_number ?? "—"}</TableCell>
                  <TableCell className="text-sm">{formatDate(a.sale.document_date)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(a.sale.grand_total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(a.amount)}</TableCell>
                </ClickableRow>
              ))}</TableBody>
            </Table>
          </div>
        </CardContent></Card>
      )}

      {((funds ?? []).length > 0 || (refunds ?? []).length > 0 || requests.length > 0) && (
        <Card><CardContent className="space-y-2 p-4 text-sm sm:p-5">
          <p className="font-medium">Sales requests and orders</p>
          {requests.map((q) => (
            <p key={q.id}>From Sales Request <Link className="font-medium text-primary hover:underline" href={`/sales/requests/${q.id}`}>{q.document_number ?? "draft"}</Link></p>
          ))}
          {((funds ?? []) as unknown as Fund[]).map((f, i) => f.order && (
            <p key={i} className="flex flex-wrap justify-between gap-2">
              <span>Order <Link className="font-medium text-primary hover:underline" href={`/sales/orders/${f.order.id}`}>{f.order.document_number}</Link></span>
              <span className="tabular-nums text-muted-foreground">committed {formatMoney(f.amount_committed)} · applied {formatMoney(f.amount_applied)}{Number(f.amount_released) > 0 ? ` · released ${formatMoney(f.amount_released)}` : ""}</span>
            </p>
          ))}
          {((refunds ?? []) as { document_number: string; amount: number; refunded_at: string; reason: string }[]).map((x) => (
            <p key={x.document_number} className="flex justify-between gap-2"><span>Refund {x.document_number} · {x.reason}</span><span className="tabular-nums">{formatMoney(x.amount)}</span></p>
          ))}
        </CardContent></Card>
      )}

      {requests.map((q) => (
        <div key={q.id} className="space-y-1">
          <p className="text-sm font-medium">Proof of payment attached to Sales Request {q.document_number}</p>
          <AttachmentsPanel ownerType="sales_request" ownerId={q.id} categories={["proof_of_payment", "other"]} />
        </div>
      ))}
      <div className="space-y-1">
        <p className="text-sm font-medium">{requests.length ? "Further documents for this payment" : "Proof of payment"}</p>
        <AttachmentsPanel ownerType="customer_receipt" ownerId={r.id} categories={["proof_of_payment", "other"]} />
      </div>
    </div>
  );
}
