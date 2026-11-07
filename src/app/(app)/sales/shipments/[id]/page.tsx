import type { Metadata } from "next";
import Link from "next/link";
import { FileDown } from "lucide-react";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AttachmentsPanel } from "@/components/common/attachments-panel";
import { StatusBadge, Timeline, Field } from "@/components/sales/sales-ui";
import { loadShipment, userNames, SHIPMENT_STATUS, EVENT_LABEL } from "@/lib/sales/fulfilment-data";
import { formatMoney, formatQuantity, formatDate, formatDateTime } from "@/lib/format";
import { ShipmentActions } from "./shipment-actions";
import { isHeadOfficeUser, salesShipmentGrnGroups } from "@/lib/transfers/grn-data";

export const metadata: Metadata = { title: "Truck" };

const DOC_LABEL: Record<string, string> = { loading_order: "Loading order", delivery_note: "Delivery note", commercial_invoice: "Commercial invoice" };

export default async function ShipmentPage(props: { params: Promise<{ id: string }> }) {
  await requirePermissionPage("sales.view");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();
  const { s, lines, docs, events } = await loadShipment(admin, ctx.user, ctx.companyId, id);
  const nameOf = await userNames(admin, [s.created_by, s.loaded_by, s.dispatched_by, s.delivery_recorded_by, s.cancelled_by, ...events.map((e) => e.user_id)]);
  const kinds = [...new Set(docs.map((d) => d.kind as string))];
  type Line = { id: string; qty_planned: number; qty_loaded: number | null; qty_dispatched: number; qty_accepted: number | null; qty_short: number; qty_damaged: number; batch_reference: string | null;
    order_line: { description: string | null; quantity: number; qty_dispatched: number; qty_allocated: number; is_free: boolean; product: { sku: string; name: string; unit: { code: string } | null } | null } | null };
  const ll = lines as unknown as Line[];
  const collection = s.order?.fulfilment_mode === "collection";
  // Sales dispatched from Head Office get GRNs per supplier, like transfers (Head Office users only).
  const { data: hqBranch } = await admin.from("branches").select("id").eq("company_id", ctx.companyId).eq("is_head_office", true).maybeSingle();
  const grnGroups = hqBranch?.id === s.branch_id && ["dispatched", "in_transit", "delivered", "collected"].includes(s.status)
    && (await isHeadOfficeUser(ctx.user, ctx.companyId)) ? await salesShipmentGrnGroups(s.id) : [];

  return (
    <div className="space-y-4">
      <PageHeader title={`Truck ${s.document_number}`}
        description={`Order ${s.order?.document_number ?? ""} · ${s.order?.customer?.name ?? ""}`}
        actions={<div className="flex flex-wrap items-center gap-2"><StatusBadge map={SHIPMENT_STATUS} status={s.status} />{s.payment_flag && <Badge variant="destructive">Payment reversed</Badge>}</div>} />
      <p className="text-sm"><Link className="text-primary hover:underline" href={`/sales/orders/${s.order?.id}`}>← Back to order {s.order?.document_number}</Link></p>
      {s.order?.on_hold && !["dispatched", "in_transit", "delivered", "collected", "cancelled"].includes(s.status) && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">The order is on hold ({s.order.hold_reason}). This truck cannot be loaded or dispatched.</p>
      )}

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 sm:p-5">
          <Field label="Vehicle">{[s.vehicle_registration, s.trailer_registration].filter(Boolean).join(" / ")}</Field>
          <Field label="Transporter">{[s.transporter_name, s.transporter_contact].filter(Boolean).join(", ")}</Field>
          <Field label="Driver">{[s.driver_name, s.driver_phone].filter(Boolean).join(", ")}{s.driver_licence && can(ctx.user, "documents.view_licence") && <span className="block text-xs text-muted-foreground">Licence {s.driver_licence}</span>}</Field>
          <Field label="Loading point">{s.dispatch_location}</Field>
          {collection
            ? <Field label="Collector">{[s.collector_name, s.collector_phone, s.collector_id_number && `ID ${s.collector_id_number}`].filter(Boolean).join(", ")}</Field>
            : <Field label="Destination">{s.destination}{s.consignee_name && <span className="block text-xs text-muted-foreground">{s.consignee_name} {s.consignee_phone ?? ""}</span>}</Field>}
          <Field label="Dispatch date">{s.planned_dispatch_date ? formatDate(s.planned_dispatch_date) : "—"}</Field>
          {s.expected_arrival_at && <Field label="Expected arrival">{formatDateTime(s.expected_arrival_at)}</Field>}
          <Field label="Loading order">{s.loading_order_number ?? "—"}</Field>
          <Field label="Delivery note">{s.delivery_note_number ?? "—"}</Field>
          {s.invoice && <Field label="Commercial invoice"><Link className="text-primary hover:underline" href={`/sales/${s.invoice.id}`}>{s.invoice.document_number}</Link> · {formatMoney(s.invoice.grand_total)}
            <span className="block text-xs text-muted-foreground">Paid {formatMoney(s.invoice.amount_paid)} · Balance {formatMoney(s.invoice.outstanding)}</span></Field>}
          {s.dispatched_at && <Field label="Dispatched">{nameOf(s.dispatched_by)}, {formatDateTime(s.dispatched_at)}</Field>}
          {s.delivered_at && <Field label={collection ? "Collected" : "Delivered"}>{s.recipient_name} {s.recipient_phone ?? ""}, {formatDateTime(s.delivered_at)}</Field>}
          {s.notes && <div className="col-span-2 sm:col-span-4"><Field label="Notes">{s.notes}</Field></div>}
          {s.cancel_reason && <Field label="Cancelled">{nameOf(s.cancelled_by)}: {s.cancel_reason}</Field>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr><th className="px-3 py-2 text-left">Product</th><th className="px-3 py-2 text-right">Planned</th><th className="px-3 py-2 text-right">Loaded</th>
                  <th className="px-3 py-2 text-right">Dispatched</th><th className="px-3 py-2 text-right">Accepted</th><th className="px-3 py-2 text-right">Short / damaged</th><th className="px-3 py-2 text-left">Batch</th></tr>
              </thead>
              <tbody>{ll.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2">{l.order_line?.description}{l.order_line?.is_free && <Badge variant="success" className="ml-2">Free</Badge>}<span className="block text-xs text-muted-foreground">{l.order_line?.product?.sku}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(l.qty_planned)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.qty_loaded === null ? "—" : formatQuantity(l.qty_loaded)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{Number(l.qty_dispatched) > 0 ? formatQuantity(l.qty_dispatched) : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.qty_accepted === null ? "—" : formatQuantity(l.qty_accepted)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{Number(l.qty_short) + Number(l.qty_damaged) > 0 ? `${formatQuantity(l.qty_short)} / ${formatQuantity(l.qty_damaged)}` : "—"}</td>
                  <td className="px-3 py-2 text-xs">{l.batch_reference ?? "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {kinds.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(["loading_order", "delivery_note", "commercial_invoice"] as const).filter((k) => kinds.includes(k)).map((k) => (
            <Button key={k} asChild variant="outline"><a href={`/api/sales/shipments/${s.id}/${k}`}><FileDown className="h-4 w-4" /> {DOC_LABEL[k]} (PDF)</a></Button>
          ))}
        </div>
      )}

      {grnGroups.length > 0 && (
        <Card><CardContent className="space-y-3 p-4 text-sm sm:p-5">
          <div>
            <h3 className="font-semibold">Goods Received Notes (Head Office)</h3>
            <p className="text-xs text-muted-foreground">One GRN per supplier of the goods on this truck, to submit to the supplier. The GRN number is given on the first download and kept.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {grnGroups.map((g) => (
              <Button key={g.key} asChild variant="outline" size="sm" className="h-auto min-h-8 whitespace-normal py-1.5 text-left">
                <a href={`/api/sales/shipments/${s.id}/grn/${g.supplierId ?? "none"}`}>
                  GRN{g.number ? ` ${g.number}` : ""} — {g.supplierName} ({g.lineIds.length} {g.lineIds.length === 1 ? "product" : "products"})
                </a>
              </Button>
            ))}
          </div>
        </CardContent></Card>
      )}

      <ShipmentActions id={s.id} status={s.status} collection={collection} onHold={!!s.order?.on_hold} canFulfil={can(ctx.user, "sales.fulfil")}
        lines={ll.map((l) => ({ id: l.id, label: `${l.order_line?.product?.sku ?? ""} ${l.order_line?.description ?? ""}`, unit: l.order_line?.product?.unit?.code ?? "",
          planned: Number(l.qty_planned), loaded: l.qty_loaded === null ? null : Number(l.qty_loaded), dispatched: Number(l.qty_dispatched), batch: l.batch_reference ?? "",
          maxLoad: Number(l.order_line?.quantity ?? 0) - Number(l.order_line?.qty_dispatched ?? 0) - Number(l.order_line?.qty_allocated ?? 0) + Number(l.qty_loaded ?? l.qty_planned) }))} />

      <AttachmentsPanel ownerType="sales_shipment" ownerId={s.id}
        categories={collection
          ? ["loading_photo", "weighbridge_ticket", "collection_authority", "collection_acknowledgement", "driver_licence", "other"]
          : ["loading_photo", "weighbridge_ticket", "signed_delivery_note", "proof_of_delivery", "offloading_photo", "driver_licence", "other"]} />
      <Timeline items={events} label={EVENT_LABEL} nameOf={nameOf} />
    </div>
  );
}
