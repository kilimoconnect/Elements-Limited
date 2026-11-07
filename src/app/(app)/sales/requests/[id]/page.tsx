import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AttachmentsPanel } from "@/components/common/attachments-panel";
import { StatusBadge, Timeline, Field } from "@/components/sales/sales-ui";
import { loadRequest, userNames, REQUEST_STATUS, EVENT_LABEL, METHOD_LABEL } from "@/lib/sales/fulfilment-data";
import { formatMoney, formatQuantity, formatDate, formatDateTime } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RequestActions } from "./request-actions";

export const metadata: Metadata = { title: "Sales Request" };

export default async function SalesRequestPage(props: { params: Promise<{ id: string }> }) {
  await requirePermissionPage("sales.view");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();
  const { rq, lines, payments, funds, events } = await loadRequest(admin, ctx.user, ctx.companyId, id);
  const nameOf = await userNames(admin, [rq.created_by, rq.submitted_by, rq.decided_by, ...events.map((e) => e.user_id)]);

  // Stock check for the reviewer: on hand minus other approved orders' reservations.
  const pids = [...new Set(lines.filter((l) => l.track_inventory).map((l) => l.product_id as string))];
  const avail: Record<string, { onHand: number; reserved: number }> = {};
  for (const pid of pids) {
    const [{ data: b }, { data: r }] = await Promise.all([
      admin.from("stock_balances").select("quantity").eq("branch_id", rq.branch_id).eq("product_id", pid).maybeSingle(),
      admin.rpc("sales_reserved_qty", { p_company: rq.company_id, p_branch: rq.branch_id, p_product: pid, p_exclude_order: null }),
    ]);
    avail[pid] = { onHand: Number(b?.quantity ?? 0), reserved: Number(r ?? 0) };
  }
  const need = new Map<string, number>();
  for (const l of lines) if (l.track_inventory) need.set(l.product_id, (need.get(l.product_id) ?? 0) + Number(l.quantity));

  const paid = payments.reduce((s, p) => s + Number(p.amount), 0);
  const fundTotal = funds.reduce((s, f) => s + Number(f.amount), 0);
  const isApprover = can(ctx.user, "sales.approve");
  const selfPrepared = ctx.user.id === rq.created_by || ctx.user.id === rq.submitted_by;
  const editable = ["draft", "returned"].includes(rq.status);

  return (
    <div className="space-y-4">
      <PageHeader title={`Sales Request ${rq.document_number ?? "(draft)"}`}
        description={`${rq.customer?.name ?? ""} · ${rq.branch?.name ?? ""}`}
        actions={<StatusBadge map={REQUEST_STATUS} status={rq.status} />} />

      {rq.status === "returned" && rq.decision_reason && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">Returned by {nameOf(rq.decided_by)}: {rq.decision_reason}</p>
      )}
      {rq.status === "rejected" && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">Rejected by {nameOf(rq.decided_by)}: {rq.decision_reason}</p>}
      {rq.status === "converted" && rq.sales_order_id && (
        <p className="rounded-md bg-success/10 px-3 py-2 text-sm">Approved by {nameOf(rq.decided_by)} on {formatDateTime(rq.decided_at)}.{" "}
          <Link className="font-medium text-primary hover:underline" href={`/sales/orders/${rq.sales_order_id}`}>Open the Sales Order</Link></p>
      )}

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 sm:p-5">
          <Field label="Customer">{rq.customer?.code} — {rq.customer?.name}</Field>
          <Field label="Contact">{[rq.contact_name, rq.contact_phone].filter(Boolean).join(", ")}</Field>
          <Field label="Fulfilment">{rq.fulfilment_mode === "delivery" ? "Delivery" : "Customer collects"}</Field>
          <Field label="Loading point">{rq.fulfilment_location}</Field>
          {rq.fulfilment_mode === "delivery" && <Field label="Destination">{rq.destination}</Field>}
          {rq.fulfilment_mode === "delivery" && <Field label="Consignee">{[rq.consignee_name, rq.consignee_phone].filter(Boolean).join(", ")}</Field>}
          <Field label="Prepared by">{nameOf(rq.created_by)}</Field>
          <Field label="Submitted">{rq.submitted_at ? `${nameOf(rq.submitted_by)}, ${formatDateTime(rq.submitted_at)}` : "—"}</Field>
          {rq.notes && <div className="col-span-2 sm:col-span-4"><Field label="Notes">{rq.notes}</Field></div>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Product</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Discount</TableHead><TableHead>Tax</TableHead><TableHead className="text-right">Total</TableHead>
                {rq.status === "pending_approval" && <TableHead className="text-right">Available stock</TableHead>}
              </TableRow></TableHeader>
              <TableBody>
                {lines.map((l) => {
                  const a = avail[l.product_id];
                  const free = a ? a.onHand - a.reserved : null;
                  return (
                    <TableRow key={l.id}>
                      <TableCell className="text-sm">{l.description}{l.is_free && <Badge variant="success" className="ml-2">Free</Badge>}<span className="block text-xs text-muted-foreground">{l.product?.sku}</span></TableCell>
                      <TableCell className="text-right tabular-nums">{formatQuantity(l.quantity)} {l.product?.unit?.code}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(l.unit_price)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(l.discount)}</TableCell>
                      <TableCell className="text-sm">{l.tax_name ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(Number(l.quantity) * Number(l.unit_price) - Number(l.discount))}</TableCell>
                      {rq.status === "pending_approval" && (
                        <TableCell className={`text-right tabular-nums ${free !== null && free < (need.get(l.product_id) ?? 0) ? "font-medium text-destructive" : ""}`}>
                          {free === null ? "n/a" : formatQuantity(free)}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-col items-end gap-1 border-t border-border p-4 text-sm">
            <p>Net {formatMoney(rq.net_total)} · Tax {formatMoney(rq.tax_total)}{Number(rq.order_discount) > 0 && <> · Order discount {formatMoney(rq.order_discount)}</>}</p>
            <p className="text-base font-semibold">Order value {formatMoney(rq.grand_total)}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4 sm:p-5">
          <p className="text-sm font-medium">Payment</p>
          {payments.length === 0 && funds.length === 0 && <p className="text-sm text-muted-foreground">No payment entered.</p>}
          {payments.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>Method</TableHead><TableHead>Received into</TableHead><TableHead>Date</TableHead><TableHead>Reference</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                <TableBody>{payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-sm">{METHOD_LABEL[p.payment_method] ?? p.payment_method}</TableCell>
                    <TableCell className="text-sm">{p.account?.name}</TableCell>
                    <TableCell className="text-sm">{formatDate(p.payment_date)}</TableCell>
                    <TableCell className="font-mono text-sm">{p.reference}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(p.amount)}</TableCell>
                    <TableCell>{p.receipt ? <Badge variant="success">Verified · {p.receipt.document_number}</Badge> : <Badge variant="warning">Pending verification</Badge>}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </div>
          )}
          {funds.map((f) => (
            <p key={f.id} className="flex justify-between text-sm"><span>Existing verified funds: {f.receipt?.document_number} ({f.receipt?.reference ?? "—"})</span><span className="tabular-nums">{formatMoney(f.amount)}</span></p>
          ))}
          <p className="flex justify-between border-t border-border pt-2 text-sm font-medium">
            <span>Covered {formatMoney(paid + fundTotal)} of {formatMoney(rq.grand_total)}</span>
            <span>{paid + fundTotal >= Number(rq.grand_total) ? (paid + fundTotal > Number(rq.grand_total) ? `Excess ${formatMoney(paid + fundTotal - Number(rq.grand_total))} stays as customer credit` : "Fully covered") : `Short ${formatMoney(Number(rq.grand_total) - paid - fundTotal)}`}</span>
          </p>
        </CardContent>
      </Card>

      <RequestActions id={rq.id} status={rq.status}
        canEdit={editable && can(ctx.user, "sales.edit_draft")} canSubmit={editable && can(ctx.user, "sales.create")}
        canDecide={rq.status === "pending_approval" && isApprover && !selfPrepared}
        selfPrepared={rq.status === "pending_approval" && isApprover && selfPrepared}
        payments={payments.filter((p) => !p.receipt_id).map((p) => ({ id: p.id, label: `${METHOD_LABEL[p.payment_method] ?? p.payment_method} ${p.reference} · ${p.account?.name ?? ""} · ${formatMoney(p.amount)}` }))} />

      <AttachmentsPanel ownerType="sales_request" ownerId={rq.id} categories={["proof_of_payment", "other"]} />
      <Timeline items={events} label={EVENT_LABEL} nameOf={nameOf} />
    </div>
  );
}
