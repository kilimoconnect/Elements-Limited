import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ClickableRow } from "@/components/common/clickable-row";
import { StatusBadge } from "@/components/sales/sales-ui";
import { SHIPMENT_STATUS, userNames } from "@/lib/sales/fulfilment-data";
import { formatMoney, formatDateTime } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Sales Approvals" };

/** Manager workspace: ONE approval queue, dispatch activity, exceptions and amendments. */
export default async function SalesApprovalsPage() {
  await requirePermissionPage("sales.approve");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const bids = ctx.branches.map((b) => b.id);

  const [{ data: queue }, { data: trucks }, { data: orders }] = await Promise.all([
    (admin.from("sales_requests").select("id, document_number, grand_total, submitted_by, submitted_at, created_by, customer:customers(name), branch:branches(code, name), payments:sales_request_payments(amount), funds:sales_request_funds(amount)")
      .eq("company_id", ctx.companyId).in("branch_id", bids).eq("status", "pending_approval").order("submitted_at")),
    (admin.from("sales_shipments").select("id, document_number, status, dispatched_at, payment_flag, vehicle_registration, order:sales_orders(document_number, customer:customers(name)), invoice:sales!sales_shipments_invoice_sale_id_fkey(document_number, grand_total)")
      .eq("company_id", ctx.companyId).in("branch_id", bids).not("dispatched_at", "is", null).order("dispatched_at", { ascending: false }).limit(30)),
    (admin.from("sales_orders").select("id").eq("company_id", ctx.companyId).in("branch_id", bids)),
  ]);
  const orderIds = (orders ?? []).map((o) => o.id);
  const [{ data: exceptions }, { data: amendments }] = orderIds.length ? await Promise.all([
    admin.from("sales_order_exceptions").select("id, kind, description, raised_at, order:sales_orders(id, document_number, customer:customers(name))").eq("status", "open").in("order_id", orderIds).order("raised_at"),
    admin.from("sales_order_amendments").select("id, kind, reason, requested_by, requested_at, order:sales_orders(id, document_number, customer:customers(name))").eq("status", "pending").in("order_id", orderIds).order("requested_at"),
  ]) : [{ data: [] }, { data: [] }];

  type Q = { id: string; document_number: string; grand_total: number; submitted_by: string | null; submitted_at: string; created_by: string | null; customer: { name: string } | null; branch: { code: string; name?: string } | null;
    payments: { amount: number }[]; funds: { amount: number }[] };
  const q = (queue ?? []) as unknown as Q[];
  type T = { id: string; document_number: string; status: string; dispatched_at: string; payment_flag: boolean; vehicle_registration: string | null;
    order: { document_number: string; customer: { name: string } | null } | null; invoice: { document_number: string; grand_total: number } | null };
  const t = (trucks ?? []) as unknown as T[];
  type X = { id: string; kind: string; description: string; raised_at: string; order: { id: string; document_number: string; customer: { name: string } | null } | null };
  const ex = (exceptions ?? []) as unknown as X[];
  type A = { id: string; kind: string; reason: string; requested_by: string; requested_at: string; order: { id: string; document_number: string; customer: { name: string } | null } | null };
  const am = (amendments ?? []) as unknown as A[];
  const nameOf = await userNames(admin, [...q.map((r) => r.submitted_by), ...am.map((a) => a.requested_by)]);

  return (
    <div className="space-y-6">
      <PageHeader title="Sales Approvals" description="Verify the payment and approve once. Approval records the receipt, reserves stock and creates the Sales Order." />

      <Section title="Waiting for your approval" count={q.length}>
        {q.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Nothing to approve.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>Submitted</TableHead><TableHead>Request</TableHead><TableHead>Customer</TableHead><TableHead>By</TableHead>
              <TableHead className="text-right">Value</TableHead><TableHead className="text-right">Payment</TableHead></TableRow></TableHeader>
            <TableBody>{q.map((r) => {
              const cover = [...r.payments, ...r.funds].reduce((s, p) => s + Number(p.amount), 0);
              const own = r.created_by === ctx.user.id || r.submitted_by === ctx.user.id;
              return (
                <ClickableRow key={r.id} href={`/sales/requests/${r.id}`}>
                  <TableCell className="text-xs">{formatDateTime(r.submitted_at)}</TableCell>
                  <TableCell className="text-sm font-medium">{r.document_number}<span className="block text-xs text-muted-foreground">{r.branch?.name ?? r.branch?.code}</span></TableCell>
                  <TableCell className="text-sm">{r.customer?.name}</TableCell>
                  <TableCell className="text-sm">{nameOf(r.submitted_by)}{own && <Badge variant="muted" className="ml-1">Yours</Badge>}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.grand_total)}</TableCell>
                  <TableCell className="text-right">{cover + 0.001 >= Number(r.grand_total) ? <Badge variant="success">Covered</Badge> : <Badge variant="destructive">Short</Badge>}</TableCell>
                </ClickableRow>
              );
            })}</TableBody>
          </Table>
        )}
      </Section>

      <Section title="Exceptions" count={ex.length}>
        {ex.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No open exceptions.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>Raised</TableHead><TableHead>Order</TableHead><TableHead>Exception</TableHead></TableRow></TableHeader>
            <TableBody>{ex.map((x) => (
              <ClickableRow key={x.id} href={`/sales/orders/${x.order?.id}`}>
                <TableCell className="text-xs">{formatDateTime(x.raised_at)}</TableCell>
                <TableCell className="text-sm font-medium">{x.order?.document_number}<span className="block text-xs text-muted-foreground">{x.order?.customer?.name}</span></TableCell>
                <TableCell className="text-sm">{x.description}</TableCell>
              </ClickableRow>
            ))}</TableBody>
          </Table>
        )}
      </Section>

      <Section title="Amendments to approve" count={am.length}>
        {am.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No amendments waiting.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>Requested</TableHead><TableHead>Order</TableHead><TableHead>Change</TableHead><TableHead>By</TableHead></TableRow></TableHeader>
            <TableBody>{am.map((a) => (
              <ClickableRow key={a.id} href={`/sales/orders/${a.order?.id}`}>
                <TableCell className="text-xs">{formatDateTime(a.requested_at)}</TableCell>
                <TableCell className="text-sm font-medium">{a.order?.document_number}<span className="block text-xs text-muted-foreground">{a.order?.customer?.name}</span></TableCell>
                <TableCell className="text-sm">{a.reason}</TableCell>
                <TableCell className="text-sm">{nameOf(a.requested_by)}</TableCell>
              </ClickableRow>
            ))}</TableBody>
          </Table>
        )}
      </Section>

      <Section title="Approved sales and dispatch activity" count={t.length}>
        {t.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No dispatches yet.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>Dispatched</TableHead><TableHead>Truck</TableHead><TableHead>Order</TableHead><TableHead>Invoice</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
            <TableBody>{t.map((s) => (
              <ClickableRow key={s.id} href={`/sales/shipments/${s.id}`}>
                <TableCell className="text-xs">{formatDateTime(s.dispatched_at)}</TableCell>
                <TableCell className="text-sm font-medium">{s.document_number}<span className="block text-xs text-muted-foreground">{s.vehicle_registration}</span></TableCell>
                <TableCell className="text-sm">{s.order?.document_number}<span className="block text-xs text-muted-foreground">{s.order?.customer?.name}</span></TableCell>
                <TableCell className="text-sm">{s.invoice?.document_number}<span className="block text-xs tabular-nums text-muted-foreground">{formatMoney(s.invoice?.grand_total)}</span></TableCell>
                <TableCell><StatusBadge map={SHIPMENT_STATUS} status={s.status} />{s.payment_flag && <Badge variant="destructive" className="ml-1">Payment issue</Badge>}</TableCell>
              </ClickableRow>
            ))}</TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">{title} <Badge variant="muted">{count}</Badge></h2>
      <Card><CardContent className="overflow-x-auto p-0">{children}</CardContent></Card>
    </section>
  );
}
