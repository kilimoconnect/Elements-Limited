import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { postPurchase, deletePurchaseDraft, voidPurchase } from "@/lib/purchases/actions";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DocStatusBadge, PayStatusBadge } from "@/components/common/doc-status-badge";
import { TxnActions } from "@/components/common/txn-actions";
import { formatMoney, formatQuantity, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApplyCreditPanel, type CreditOpt } from "./apply-credit";

export const metadata: Metadata = { title: "Purchase" };
type Params = Promise<{ id: string }>;

export default async function PurchaseDetailPage(props: { params: Params }) {
  await requirePermissionPage("purchases.view");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();
  const showCost = can(ctx.user, "purchases.view_cost");

  const { data: pur } = await admin.from("purchases")
    .select("*, supplier:suppliers(code,name,phone), branch:branches(name,code)").eq("id", id).maybeSingle();
  if (!pur || pur.company_id !== ctx.companyId) notFound();

  const [{ data: lines }, { data: payments }, { data: returns }, { data: payable }] = await Promise.all([
    admin.from("purchase_lines").select("*").eq("purchase_id", id).order("line_no"),
    admin.from("purchase_payments").select("amount, payment_date, account:payment_accounts(name)").eq("purchase_id", id),
    admin.from("purchase_returns").select("id, document_number, document_date, total, fc_total, document_status").eq("purchase_id", id).order("created_at", { ascending: false }),
    admin.from("supplier_payables").select("id, status, outstanding, fc_outstanding, fc_original").eq("purchase_id", id).maybeSingle(),
  ]);

  const s = pur as Record<string, unknown> as {
    document_number: string | null; document_status: string; payment_status: string; document_date: string;
    supplier_id: string; supplier_invoice_number: string | null; due_date: string | null; grand_total: number; net_total: number;
    tax_total: number; recoverable_tax: number; amount_paid: number; outstanding: number; inventory_value: number;
    currency_code: string; exchange_rate: number; rate_source: string | null; rate_reference: string | null;
    fc_grand_total: number; fc_tax_total: number; fc_subtotal: number; advance_applied_fc: number; advance_applied_tzs: number;
    void_reason: string | null; supplier: { name: string; phone: string | null } | null; branch: { name: string } | null;
  };
  const isFc = s.currency_code !== "TZS";
  const pb = payable as { id: string; status: string; outstanding: number; fc_outstanding: number; fc_original: number } | null;
  const openAmount = pb ? (isFc ? Number(pb.fc_outstanding) : Number(pb.outstanding)) : 0;
  const ll = (lines ?? []) as unknown as Array<{ id: string; description: string; quantity: number; unit_cost: number; discount: number; tax_name: string | null; tax_rate: number; net_amount: number; tax_amount: number; gross_amount: number; inventory_value: number; fc_gross_amount: number | null }>;

  // Open supplier credits in this invoice's currency, and the foreign balance history.
  const [{ data: creditRows }, { data: events }] = await Promise.all([
    pb && openAmount > 0 && s.document_status === "posted" && can(ctx.user, "purchases.record_payment")
      ? admin.from("supplier_credits").select("id, fc_remaining, remaining, credit_date, return:purchase_returns(document_number)")
          .eq("company_id", ctx.companyId).eq("supplier_id", s.supplier_id).eq("currency_code", s.currency_code).eq("status", "open").gt("fc_remaining", 0)
      : Promise.resolve({ data: [] }),
    pb && isFc ? admin.from("supplier_payable_events").select("event_type, event_date, fc_delta, tzs_delta, created_at").eq("payable_id", pb.id).order("created_at")
      : Promise.resolve({ data: [] }),
  ]);
  const credits: CreditOpt[] = ((creditRows ?? []) as unknown as Array<{ id: string; fc_remaining: number; remaining: number; credit_date: string; return: { document_number: string | null } | null }>)
    .map((c) => ({ id: c.id, label: `Credit ${c.return?.document_number ?? ""}`, date: c.credit_date, fc_remaining: Number(c.fc_remaining), remaining: Number(c.remaining) }));
  const EVENT_LABEL: Record<string, string> = {
    invoice: "Invoice", settlement: "Payment", settlement_void: "Payment voided", return: "Return", return_void: "Return voided",
    credit_application: "Credit applied", revaluation: "Revaluation", revaluation_void: "Revaluation voided", invoice_void: "Invoice voided",
  };

  return (
    <div>
      <PageHeader title={s.document_number ?? "Purchase (draft)"} description={`${s.branch?.name} · ${formatDate(s.document_date)}`}
        actions={
          <div className="flex items-center gap-2">
            {s.document_status === "posted" && Number(s.outstanding) > 0 && can(ctx.user, "purchases.record_payment") && (
              <Button asChild variant="outline"><Link href={`/purchases/supplier-payments/new?purchase=${id}`}>Record payment</Link></Button>
            )}
            {s.document_status === "posted" && can(ctx.user, "purchases.create_return") && (
              <Button asChild variant="outline"><Link href={`/purchases/${id}/return`}>Return</Link></Button>
            )}
            <TxnActions id={id} status={s.document_status} canPost={can(ctx.user, "purchases.post")} canOwner={can(ctx.user, "transactions.void")}
              postAction={postPurchase} deleteAction={deletePurchaseDraft} voidAction={voidPurchase} afterDeletePush="/purchases/history" />
          </div>
        } />

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card><CardContent className="space-y-1 p-5 text-sm">
          <p className="text-xs uppercase text-muted-foreground">Supplier</p>
          <p className="font-medium">{s.supplier?.name}</p><p className="text-muted-foreground">{s.supplier?.phone ?? ""}</p>
          <p className="text-xs text-muted-foreground">Invoice: {s.supplier_invoice_number ?? "—"}</p>
          {isFc && (
            <div className="mt-2 border-t border-border pt-2 text-xs">
              <p><span className="text-muted-foreground">Currency</span> <span className="font-medium">{s.currency_code}</span></p>
              <p><span className="text-muted-foreground">Rate</span> <span className="tabular-nums">TZS {Number(s.exchange_rate)} per 1 {s.currency_code}</span></p>
              <p><span className="text-muted-foreground">Rate source</span> {s.rate_source === "rate_table" ? "Exchange-rate table" : "Manual (authorised)"}{s.rate_reference ? ` · ${s.rate_reference}` : ""}</p>
            </div>
          )}
        </CardContent></Card>
        <Card><CardContent className="space-y-2 p-5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Status</span><DocStatusBadge status={s.document_status} /></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Payment</span><PayStatusBadge status={s.payment_status} /></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Due date</span><span>{s.due_date ? formatDate(s.due_date) : "—"}</span></div>
          {s.void_reason && <div className="flex justify-between"><span className="text-muted-foreground">Void reason</span><span>{s.void_reason}</span></div>}
        </CardContent></Card>
        <Card><CardContent className="space-y-1.5 p-5 text-sm">
          {isFc && (
            <div className="mb-2 space-y-1 border-b border-border pb-2">
              <div className="flex justify-between"><span className="text-muted-foreground">Invoice ({s.currency_code})</span><span className="tabular-nums font-semibold">{formatMoney(s.fc_grand_total)}</span></div>
              {Number(s.advance_applied_fc) > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Advances applied ({s.currency_code})</span><span className="tabular-nums">{formatMoney(s.advance_applied_fc)}</span></div>}
              {pb && <div className="flex justify-between font-medium"><span>Open ({s.currency_code})</span><span className="tabular-nums">{formatMoney(pb.fc_outstanding)}</span></div>}
              <p className="text-xs text-muted-foreground">TZS figures below are the posted TZS amounts; &quot;Outstanding&quot; is the TZS carrying amount of the open {s.currency_code} balance.</p>
            </div>
          )}
          <div className="flex justify-between"><span className="text-muted-foreground">Net</span><span className="tabular-nums">{formatMoney(s.net_total)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="tabular-nums">{formatMoney(s.tax_total)}</span></div>
          <div className="flex justify-between font-semibold"><span>Total</span><span className="tabular-nums">{formatMoney(s.grand_total)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Paid</span><span className="tabular-nums">{formatMoney(s.amount_paid)}</span></div>
          <div className="flex justify-between font-medium"><span>Outstanding</span><span className="tabular-nums">{formatMoney(s.outstanding)}</span></div>
          {showCost && <div className="mt-1 flex justify-between border-t border-border pt-1"><span className="text-muted-foreground">Inventory value</span><span className="tabular-nums">{formatMoney(s.inventory_value)}</span></div>}
          {showCost && <div className="flex justify-between"><span className="text-muted-foreground">Recoverable VAT</span><span className="tabular-nums">{formatMoney(s.recoverable_tax)}</span></div>}
        </CardContent></Card>
      </div>

      <Card className="mb-4"><CardContent className="p-0">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Item</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Disc</TableHead><TableHead>Tax</TableHead>
            {isFc && <TableHead className="text-right">Total ({s.currency_code})</TableHead>}
            <TableHead className="text-right">Net (TZS)</TableHead><TableHead className="text-right">Total (TZS)</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {ll.map((l) => (
              <TableRow key={l.id}>
                <TableCell>{l.description}</TableCell>
                <TableCell className="text-right tabular-nums">{formatQuantity(l.quantity)}</TableCell>
                <TableCell className="text-right tabular-nums">{isFc ? `${s.currency_code} ` : ""}{formatMoney(l.unit_cost)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(l.discount)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{l.tax_name ? `${l.tax_name} (${l.tax_rate}%)` : "—"}</TableCell>
                {isFc && <TableCell className="text-right tabular-nums">{l.fc_gross_amount == null ? "—" : formatMoney(l.fc_gross_amount)}</TableCell>}
                <TableCell className="text-right tabular-nums">{formatMoney(l.net_amount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(l.gross_amount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent></Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card><CardContent className="p-5">
          <h3 className="mb-2 text-sm font-semibold">Payments</h3>
          {(payments ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No payments.</p> : (
            <div className="space-y-1 text-sm">{(payments ?? []).map((p, i) => { const pp = p as unknown as { account: { name: string } | null; amount: number; payment_date: string }; return <div key={i} className="flex justify-between"><span className="text-muted-foreground">{pp.account?.name} · {formatDate(pp.payment_date)}</span><span className="tabular-nums">{formatMoney(pp.amount)}</span></div>; })}</div>
          )}
        </CardContent></Card>
        <Card><CardContent className="p-5">
          <h3 className="mb-2 text-sm font-semibold">Returns</h3>
          {(returns ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No returns.</p> : (
            <div className="space-y-1 text-sm">{(returns ?? []).map((r) => { const rr = r as { id: string; document_number: string | null; document_date: string; total: number; fc_total: number; document_status: string }; return <div key={rr.id} className="flex justify-between"><span className="text-muted-foreground">{rr.document_number} · {formatDate(rr.document_date)} · <DocStatusBadge status={rr.document_status} /></span><span className="tabular-nums">{isFc && <>{s.currency_code} {formatMoney(rr.fc_total)} · </>}TZS {formatMoney(rr.total)}</span></div>; })}</div>
          )}
        </CardContent></Card>
      </div>

      {credits.length > 0 && pb && (
        <Card className="mt-4"><CardContent className="p-5">
          <h3 className="mb-2 text-sm font-semibold">Apply supplier credit ({s.currency_code})</h3>
          <ApplyCreditPanel payableId={pb.id} currency={s.currency_code} credits={credits} maxOpen={openAmount} />
        </CardContent></Card>
      )}

      {isFc && (events ?? []).length > 0 && (
        <Card className="mt-4"><CardContent className="p-0">
          <h3 className="px-5 pt-4 text-sm font-semibold">{s.currency_code} balance history</h3>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>Event</TableHead>
              <TableHead className="text-right">{s.currency_code}</TableHead><TableHead className="text-right">TZS carrying</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {((events ?? []) as Array<{ event_type: string; event_date: string; fc_delta: number; tzs_delta: number }>).map((e, i) => (
                <TableRow key={i}>
                  <TableCell>{formatDate(e.event_date)}</TableCell>
                  <TableCell>{EVENT_LABEL[e.event_type] ?? e.event_type}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(e.fc_delta)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(e.tzs_delta)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}
    </div>
  );
}
