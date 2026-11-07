import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ClickableRow } from "@/components/common/clickable-row";
import { StatusBadge, Timeline, Field } from "@/components/sales/sales-ui";
import { loadOrder, userNames, customerAvailableFunds, ORDER_STATUS, SHIPMENT_STATUS, EVENT_LABEL, METHOD_LABEL } from "@/lib/sales/fulfilment-data";
import { formatMoney, formatQuantity, formatDateTime } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OrderActions } from "./order-actions";

export const metadata: Metadata = { title: "Sales Order" };

const inv = (x: unknown) => (Array.isArray(x) ? x[0] : x) as { document_number: string; grand_total: number } | null | undefined;

export default async function SalesOrderPage(props: { params: Promise<{ id: string }> }) {
  await requirePermissionPage("sales.view");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();
  const { o, lines, funds, available, shipments, exceptions, amendments, events } = await loadOrder(admin, ctx.user, ctx.companyId, id);
  const nameOf = await userNames(admin, [o.approved_by, o.request?.created_by, ...events.map((e) => e.user_id), ...amendments.map((a) => a.requested_by),
    ...exceptions.map((x) => x.resolved_by)]);
  const truckNo = (sid: string | null) => shipments.find((s) => s.id === sid)?.document_number ?? null;

  const open = ["approved", "in_fulfilment"].includes(o.status);
  const goods = lines.filter((l) => l.track_inventory);
  const invoiced = lines.reduce((s, l) => s + Number(l.invoiced_net) + Number(l.invoiced_tax), 0);
  const committed = funds.reduce((s, f) => s + Number(f.amount_committed) - Number(f.amount_released), 0);
  const applied = funds.reduce((s, f) => s + Number(f.amount_applied), 0);
  const canFulfil = can(ctx.user, "sales.fulfil");
  const isManager = can(ctx.user, "sales.approve");
  const fullyAllocated = goods.every((l) => Number(l.qty_dispatched) + Number(l.qty_allocated) >= Number(l.quantity) - 0.00005);
  const { data: allBranches } = await admin.from("branches").select("id, name").eq("company_id", ctx.companyId).eq("is_active", true).order("name");
  const otherFunds = isManager && open ? await customerAvailableFunds(admin, ctx.companyId, o.customer_id) : [];
  const { data: accounts } = isManager
    ? await admin.from("payment_accounts").select("id, name, branch_id").eq("company_id", ctx.companyId).eq("is_active", true).order("code")
    : { data: [] as { id: string; name: string; branch_id: string | null }[] };

  return (
    <div className="space-y-4">
      <PageHeader title={`Sales Order ${o.document_number}`} description={`${o.customer?.name ?? ""} · ${o.branch?.name ?? ""}`}
        actions={<div className="flex flex-wrap items-center gap-2"><StatusBadge map={ORDER_STATUS} status={o.status} />{o.on_hold && <Badge variant="destructive">On hold</Badge>}</div>} />
      {o.on_hold && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">On hold: {o.hold_reason}. No truck can be loaded or dispatched until a manager resolves it.</p>}

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 sm:p-5">
          <Field label="Customer">{o.customer?.code} — {o.customer?.name}</Field>
          <Field label="Fulfilment">{o.fulfilment_mode === "delivery" ? `Delivery to ${o.destination ?? "—"}` : "Customer collects"}</Field>
          <Field label="Approved">{nameOf(o.approved_by)}, {formatDateTime(o.approved_at)}</Field>
          <Field label="Request"><Link className="text-primary hover:underline" href={`/sales/requests/${o.request?.id}`}>{o.request?.document_number}</Link> by {nameOf(o.request?.created_by)}</Field>
          {o.verification_basis && <div className="col-span-2 sm:col-span-4"><Field label="Payment verification">{o.verification_basis}</Field></div>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Product</TableHead><TableHead className="text-right">Approved</TableHead><TableHead className="text-right">On trucks</TableHead>
                <TableHead className="text-right">Dispatched</TableHead><TableHead className="text-right">Delivered</TableHead><TableHead className="text-right">Remaining</TableHead>
                <TableHead className="text-right">Value</TableHead><TableHead className="text-right">Invoiced</TableHead>
              </TableRow></TableHeader>
              <TableBody>{lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-sm">{l.description}{l.is_free && <Badge variant="success" className="ml-2">Free</Badge>}{!l.track_inventory && <Badge variant="muted" className="ml-2">Charge</Badge>}
                    <span className="block text-xs text-muted-foreground">{l.product?.sku} · {formatMoney(l.unit_price)}/{l.product?.unit?.code ?? "unit"}</span></TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(l.quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.track_inventory ? formatQuantity(l.qty_allocated) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(l.qty_dispatched)}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.track_inventory ? formatQuantity(l.qty_delivered) : "—"}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatQuantity(Number(l.quantity) - Number(l.qty_dispatched))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(l.line_total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(Number(l.invoiced_net) + Number(l.invoiced_tax))}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
          <div className="grid grid-cols-2 gap-3 border-t border-border p-4 text-sm sm:grid-cols-4">
            <Field label="Order value"><span className="font-semibold tabular-nums">{formatMoney(o.grand_total)}</span></Field>
            <Field label="Invoiced so far"><span className="tabular-nums">{formatMoney(invoiced)}</span></Field>
            <Field label="Funds committed"><span className="tabular-nums">{formatMoney(committed)}</span></Field>
            <Field label="Applied to truck invoices"><span className="tabular-nums">{formatMoney(applied)}</span></Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Trucks</p>
            {open && canFulfil && !o.on_hold && !fullyAllocated && (
              <Button asChild size="sm"><Link href={`/sales/orders/${o.id}/trucks/new`}><Plus className="h-4 w-4" /> New truck</Link></Button>
            )}
          </div>
          {shipments.length === 0 ? <p className="text-sm text-muted-foreground">No trucks yet.</p> : (
            <div className="-mx-4 overflow-x-auto sm:mx-0">
              <Table>
                <TableHeader><TableRow><TableHead>Truck</TableHead><TableHead>Vehicle / collector</TableHead><TableHead className="text-right">Quantity</TableHead>
                  <TableHead>Status</TableHead><TableHead>LO / DN</TableHead><TableHead>Invoice</TableHead></TableRow></TableHeader>
                <TableBody>{shipments.map((s) => {
                  const q = (s.lines ?? []).reduce((a: number, l: { qty_dispatched: number; qty_loaded: number | null; qty_planned: number }) =>
                    a + Number(Number(l.qty_dispatched) > 0 ? l.qty_dispatched : l.qty_loaded ?? l.qty_planned), 0);
                  return (
                    <ClickableRow key={s.id} href={`/sales/shipments/${s.id}`}>
                      <TableCell className="text-sm font-medium">{s.document_number}{s.payment_flag && <Badge variant="destructive" className="ml-2">Payment issue</Badge>}</TableCell>
                      <TableCell className="text-sm">{s.vehicle_registration ?? s.collector_name ?? "—"}{s.driver_name && <span className="block text-xs text-muted-foreground">{s.driver_name}</span>}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatQuantity(q)}</TableCell>
                      <TableCell><StatusBadge map={SHIPMENT_STATUS} status={s.status} /></TableCell>
                      <TableCell className="text-xs">{s.loading_order_number ?? "—"}<span className="block">{s.delivery_note_number ?? ""}</span></TableCell>
                      <TableCell className="text-sm">{inv(s.invoice) ? <>{inv(s.invoice)!.document_number}<span className="block text-xs text-muted-foreground">{formatMoney(inv(s.invoice)!.grand_total)}</span></> : "—"}</TableCell>
                    </ClickableRow>
                  );
                })}</TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4 sm:p-5">
          <p className="text-sm font-medium">Funds</p>
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <Table>
              <TableHeader><TableRow><TableHead>Receipt</TableHead><TableHead>Reference</TableHead><TableHead className="text-right">Receipt amount</TableHead>
                <TableHead className="text-right">Committed</TableHead><TableHead className="text-right">Applied</TableHead><TableHead className="text-right">Released</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>{funds.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="text-sm">{f.receipt?.document_number}<span className="block text-xs text-muted-foreground">{METHOD_LABEL[f.receipt?.payment_method ?? ""] ?? ""}</span></TableCell>
                  <TableCell className="font-mono text-xs">{f.receipt?.reference}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(f.receipt?.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(f.amount_committed)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(f.amount_applied)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(f.amount_released)}</TableCell>
                  <TableCell>{f.receipt?.document_status === "voided" ? <Badge variant="destructive">Reversed</Badge> : <Badge variant="success">Verified</Badge>}
                    {available[f.receipt_id] > 0 && <span className="block text-xs text-muted-foreground">{formatMoney(available[f.receipt_id])} customer credit</span>}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <OrderActions orderId={o.id} open={open} isManager={isManager} canFulfil={canFulfil} userId={ctx.user.id} canApproveOwn={can(ctx.user, "sales.approve_own")}
        lines={lines.map((l) => ({ id: l.id, description: l.description ?? l.product?.name ?? "", quantity: Number(l.quantity), unit_price: Number(l.unit_price),
          min: Number(l.qty_dispatched) + Number(l.qty_allocated), charge: !l.track_inventory }))}
        delivery={{ destination: o.destination ?? "", consignee_name: o.consignee_name ?? "", consignee_phone: o.consignee_phone ?? "" }}
        exceptions={exceptions.map((x) => ({ id: x.id, kind: x.kind, description: x.description, status: x.status, resolution: x.resolution, resolved_by: nameOf(x.resolved_by), raised_at: x.raised_at, truck: truckNo(x.shipment_id) }))}
        amendments={amendments.map((a) => ({ id: a.id, kind: a.kind, reason: a.reason, status: a.status, changes: a.changes, requested_by: a.requested_by, requester: nameOf(a.requested_by),
          requested_at: a.requested_at, value_change: a.value_change, decision_reason: a.decision_reason }))}
        receipts={funds.filter((f) => f.receipt?.document_status === "posted").map((f) => ({ id: f.receipt_id, label: `${f.receipt?.document_number} · ${f.receipt?.reference ?? ""}`, available: available[f.receipt_id] ?? 0 }))}
        otherFunds={otherFunds.map((f) => ({ id: f.id, label: `${f.document_number} · ${f.reference ?? ""}`, available: f.available }))}
        branches={(allBranches ?? []).filter((b) => b.id !== o.branch_id)}
        accounts={(accounts ?? []).filter((a) => !a.branch_id || a.branch_id === o.branch_id).map((a) => ({ id: a.id, name: a.name }))} />

      <Timeline items={events} label={EVENT_LABEL} nameOf={nameOf} shipmentNo={truckNo} />
    </div>
  );
}
