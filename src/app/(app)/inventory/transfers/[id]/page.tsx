import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatQuantity, formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { AttachmentsPanel } from "@/components/common/attachments-panel";
import type { AttachmentCategory } from "@/lib/attachments/policy";
import { TransferActions, type TLine } from "./transfer-actions";
import { TripActions, ResolveButton, AddAgentForm, AddUpdateForm, ChargeForm, ChargeRowActions } from "./transfer-file";

export const metadata: Metadata = { title: "Transfer" };
type Params = Promise<{ id: string }>;
const N = (v: unknown) => Number(v ?? 0);

export default async function TransferDetailPage(props: { params: Params }) {
  await requirePermissionPage("inventory.transfer_view");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();
  const { data: t } = await admin.from("stock_transfers")
    .select("*, source:branches!stock_transfers_source_branch_id_fkey(name,code), dest:branches!stock_transfers_destination_branch_id_fkey(name,code)")
    .eq("id", id).maybeSingle();
  if (!t || t.company_id !== ctx.companyId) notFound();
  const mine = (b: string) => ctx.user.isOwner || ctx.user.branchIds.includes(b);
  const isSender = mine(t.source_branch_id), isReceiver = mine(t.destination_branch_id);
  if (!isSender && !isReceiver) notFound(); // unrelated branches see nothing

  const showCost = can(ctx.user, "inventory.view_cost");
  const canLicence = can(ctx.user, "documents.view_licence");
  const canResolve = can(ctx.user, "inventory.transfer_resolve") && isReceiver;
  const canReceive = can(ctx.user, "inventory.transfer_receive") && isReceiver;
  const canDispatch = can(ctx.user, "inventory.transfer_dispatch") && isSender;
  const logistics = await isFeatureEnabled(ctx.companyId, "transfer_logistics");
  const attachmentsOn = await isFeatureEnabled(ctx.companyId, "attachments");

  const [{ data: lines }, { data: trips }, { data: receipts }, { data: agents }, { data: events }, { data: charges }, { data: categories }, { data: versions }] = await Promise.all([
    admin.from("stock_transfer_lines").select("id, line_no, qty_requested, qty_dispatched, qty_received, qty_quarantined, qty_short_pending, qty_lost_normal, qty_lost_abnormal, unit_cost, transit_value, received_value, lost_value, charges_applied, batch_reference, kg_per_unit, product:products(sku,name)").eq("transfer_id", id).order("line_no"),
    admin.from("stock_transfer_dispatches").select("*, lines:stock_transfer_dispatch_lines(id, transfer_line_id, qty, net_kg, value, transit_value, qty_reported, qty_accepted, qty_quarantined, qty_short, qty_lost_normal, qty_lost_abnormal), changes:stock_transfer_dispatch_changes(old_values, new_values, reason, changed_at)").eq("transfer_id", id).order("trip_no"),
    admin.from("stock_transfer_receipts").select("id, document_number, dispatch_id, arrived_at, received_at, signed_by_name, notes, lines:stock_transfer_receipt_lines(id, transfer_line_id, qty_received, qty_damaged, qty_short, qty_released, qty_resolved_damaged, qty_resolved_short, value, resolutions:stock_transfer_resolutions(kind, resolution, qty, value, created_at))").eq("transfer_id", id).order("received_at"),
    admin.from("stock_transfer_agents").select("id, name, company_name, phone, role").eq("transfer_id", id).order("created_at"),
    admin.from("stock_transfer_events").select("id, event_type, note, created_at, dispatch_id").eq("transfer_id", id).order("created_at", { ascending: false }).limit(100),
    showCost ? admin.from("cost_sources").select("id, description, status, estimated_amount, accrued_amount, actual_amount, allocation_basis, inventory_treatment, transfer_dispatch_id, category:cost_categories(name)").eq("stock_transfer_id", id).neq("status", "voided").order("created_at") : Promise.resolve({ data: [] }),
    admin.from("cost_categories").select("id, code, name, inventory_treatment").eq("company_id", ctx.companyId).eq("is_active", true).eq("applies_to_transfer", true).order("code"),
    admin.from("document_versions").select("id, owner_id, version, created_at").eq("owner_type", "stock_transfer_dispatch").eq("kind", "delivery_note").eq("company_id", ctx.companyId).order("version", { ascending: false }),
  ]);
  type L = { id: string; line_no: number; qty_requested: number; qty_dispatched: number; qty_received: number; qty_quarantined: number; qty_short_pending: number;
    qty_lost_normal: number; qty_lost_abnormal: number; unit_cost: number; transit_value: number; received_value: number; lost_value: number; charges_applied: number;
    batch_reference: string | null; kg_per_unit: number | null; product: { sku: string; name: string } | null };
  const ls = (lines ?? []) as unknown as L[];
  type Trip = Record<string, unknown> & { id: string; trip_no: number; status: string; document_number: string | null; driver_name: string | null; driver_phone: string | null;
    driver_licence: string | null; vehicle_registration: string | null; trailer_registration: string | null; transporter_name: string | null; transporter_contact: string | null;
    dispatch_date: string; dispatched_at: string | null; expected_arrival_at: string | null; arrived_at: string | null; notes: string | null; void_reason: string | null;
    lines: { id: string; transfer_line_id: string; qty: number; net_kg: number | null; value: number; transit_value: number; qty_reported: number; qty_accepted: number; qty_quarantined: number; qty_short: number; qty_lost_normal: number; qty_lost_abnormal: number }[];
    changes: { old_values: Record<string, string>; new_values: Record<string, string>; reason: string; changed_at: string }[] };
  const tripsList = (trips ?? []) as unknown as Trip[];
  type Rc = { id: string; document_number: string | null; dispatch_id: string | null; arrived_at: string | null; received_at: string; signed_by_name: string | null; notes: string | null;
    lines: { id: string; transfer_line_id: string; qty_received: number; qty_damaged: number; qty_short: number; qty_released: number; qty_resolved_damaged: number; qty_resolved_short: number; value: number;
      resolutions: { kind: string; resolution: string; qty: number; value: number; created_at: string }[] }[] };
  const rcs = (receipts ?? []) as unknown as Rc[];
  const lname = (lid: string) => { const l = ls.find((x) => x.id === lid); return l ? `${l.product?.sku} — ${l.product?.name}` : "—"; };
  const tLines: TLine[] = ls.map((r) => ({ id: r.id, sku: r.product?.sku ?? "", name: r.product?.name ?? "", qty_dispatched: N(r.qty_dispatched), qty_received: N(r.qty_received) }));
  const remainingToDispatch = ls.some((l) => N(l.qty_requested) > N(l.qty_dispatched));
  const tripOpts = tripsList.filter((x) => x.status !== "voided").map((x) => ({ id: x.id, label: x.document_number ?? `Trip ${x.trip_no} (draft)` }));
  const legacy = !t.posts_in_transit;
  const tripCats: AttachmentCategory[] = ["cargo_papers", "loading_photo", "weighbridge_ticket", "signed_delivery_note", "offloading_photo", "other",
    ...(canLicence ? ["driver_licence" as const] : []), ...(can(ctx.user, "documents.view_financial") ? ["transport_invoice" as const] : [])];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t.document_number ?? "Transfer (draft)"}
        description={`${t.source?.code} — ${t.source?.name} → ${t.dest?.code} — ${t.dest?.name}${isSender && isReceiver ? "" : isSender ? " · you are the sending branch" : " · you are the receiving branch"}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {logistics && !legacy && canDispatch && remainingToDispatch && t.status !== "voided" &&
              <Button asChild variant="outline"><Link href={`/inventory/transfers/${id}/trips/new`}>New dispatch trip</Link></Button>}
            <TransferActions id={id} status={t.status} lines={tLines}
              canDispatch={canDispatch && tripsList.length === 0} canReceive={canReceive && (legacy || tripsList.length <= 1)} canVoid={can(ctx.user, "transactions.void")} />
          </div>
        }
      />

      <Card><CardContent className="flex flex-wrap gap-x-8 gap-y-3 p-5 text-sm">
        <div><p className="text-xs uppercase text-muted-foreground">Status</p><DocStatusBadge status={t.status} />{t.has_open_discrepancy && <Badge variant="warning" className="ml-1">open discrepancy</Badge>}</div>
        <div><p className="text-xs uppercase text-muted-foreground">Costing</p><p>{t.cost_status}</p></div>
        <div><p className="text-xs uppercase text-muted-foreground">Date</p><p>{formatDate(t.transfer_date)}</p></div>
        <div><p className="text-xs uppercase text-muted-foreground">Warehouses</p><p>{t.source_location ?? "—"} → {t.destination_location ?? "—"}</p></div>
        <div><p className="text-xs uppercase text-muted-foreground">Reference</p><p>{t.reference ?? "—"}</p></div>
        {legacy && <div><p className="text-xs uppercase text-muted-foreground">Engine</p><p>Dispatched before the upgrade (no trips)</p></div>}
        {t.void_reason && <div><p className="text-xs uppercase text-muted-foreground">Void reason</p><p>{t.void_reason}</p></div>}
      </CardContent></Card>

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Product / batch</TableHead><TableHead className="text-right">Requested</TableHead><TableHead className="text-right">Dispatched</TableHead>
            <TableHead className="text-right">Accepted</TableHead><TableHead className="text-right">Quarantined</TableHead><TableHead className="text-right">Short (open)</TableHead>
            <TableHead className="text-right">Lost</TableHead><TableHead className="text-right">Outstanding</TableHead><TableHead className="text-right">Net kg dispatched</TableHead>
            {showCost && <><TableHead className="text-right">In transit (TZS)</TableHead><TableHead className="text-right">Received (TZS)</TableHead><TableHead className="text-right">Charges</TableHead></>}
          </TableRow></TableHeader>
          <TableBody>
            {ls.map((r) => {
              const lost = N(r.qty_lost_normal) + N(r.qty_lost_abnormal);
              const out = N(r.qty_dispatched) - N(r.qty_received) - N(r.qty_quarantined) - N(r.qty_short_pending) - lost;
              return (
                <TableRow key={r.id}>
                  <TableCell><span className="font-mono text-xs">{r.product?.sku}</span> — {r.product?.name}{r.batch_reference && <p className="text-xs text-muted-foreground">Batch {r.batch_reference}</p>}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(N(r.qty_requested))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(N(r.qty_dispatched))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(N(r.qty_received))}</TableCell>
                  <TableCell className="text-right tabular-nums">{N(r.qty_quarantined) ? formatQuantity(N(r.qty_quarantined)) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{N(r.qty_short_pending) ? formatQuantity(N(r.qty_short_pending)) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{lost ? formatQuantity(lost) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatQuantity(legacy ? N(r.qty_dispatched) - N(r.qty_received) : Math.max(out, 0))}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.kg_per_unit ? formatQuantity(N(r.qty_dispatched) * N(r.kg_per_unit)) : "—"}</TableCell>
                  {showCost && <>
                    <TableCell className="text-right tabular-nums">{formatMoney(legacy ? (N(r.qty_dispatched) - N(r.qty_received)) * N(r.unit_cost) : N(r.transit_value))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(N(r.received_value))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(N(r.charges_applied))}</TableCell>
                  </>}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {tripsList.map((trip) => {
        const vers = ((versions ?? []) as { id: string; owner_id: string; version: number; created_at: string }[]).filter((v) => v.owner_id === trip.id);
        const tripReceipts = rcs.filter((r) => r.dispatch_id === trip.id);
        return (
          <Card key={trip.id}><CardContent className="space-y-3 p-5 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold">{trip.document_number ?? `Trip ${trip.trip_no} (draft)`} <Badge variant={trip.status === "received" ? "success" : trip.status === "voided" ? "secondary" : "warning"}>{trip.status}</Badge></h3>
                <p className="text-xs text-muted-foreground">Dispatch {trip.dispatched_at ? formatDateTime(trip.dispatched_at) : formatDate(trip.dispatch_date)} · ETA {trip.expected_arrival_at ? formatDateTime(trip.expected_arrival_at) : "—"} · Arrived {trip.arrived_at ? formatDateTime(trip.arrived_at) : "—"}</p>
              </div>
              <TripActions transferId={id} tripId={trip.id} status={trip.status} isSender={canDispatch} isReceiver={canReceive} canVoid={can(ctx.user, "transactions.void")} canLicence={canLicence}
                transport={{ driver_name: trip.driver_name ?? "", driver_phone: trip.driver_phone ?? "", ...(canLicence ? { driver_licence: trip.driver_licence ?? "" } : {}),
                  vehicle_registration: trip.vehicle_registration ?? "", trailer_registration: trip.trailer_registration ?? "", transporter_name: trip.transporter_name ?? "", transporter_contact: trip.transporter_contact ?? "" }} />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <div><p className="text-xs text-muted-foreground">Driver</p><p>{trip.driver_name ?? "—"}{trip.driver_phone && <> · <a className="underline" href={`tel:${trip.driver_phone}`}>{trip.driver_phone}</a></>}</p>
                {canLicence && trip.driver_licence && <p className="text-xs text-muted-foreground">Licence {trip.driver_licence}</p>}</div>
              <div><p className="text-xs text-muted-foreground">Truck / trailer</p><p>{trip.vehicle_registration ?? "—"} / {trip.trailer_registration ?? "—"}</p></div>
              <div><p className="text-xs text-muted-foreground">Transporter</p><p>{trip.transporter_name ?? "—"}{trip.transporter_contact && <> · {trip.transporter_contact}</>}</p></div>
              <div><p className="text-xs text-muted-foreground">Delivery note</p>{vers.length === 0 ? <p>—</p> : vers.map((v) => (
                <p key={v.id}><a className="underline" href={`/api/transfers/delivery-notes/${v.id}`} target="_blank" rel="noopener">v{v.version}</a> <span className="text-xs text-muted-foreground">{formatDateTime(v.created_at)}</span></p>
              ))}</div>
            </div>
            <Table>
              <TableHeader><TableRow><TableHead>Cargo</TableHead><TableHead className="text-right">Loaded</TableHead><TableHead className="text-right">Net kg</TableHead>
                <TableHead className="text-right">Arrived</TableHead><TableHead className="text-right">Accepted</TableHead><TableHead className="text-right">Quarantined</TableHead><TableHead className="text-right">Short</TableHead>
                <TableHead className="text-right">To arrive</TableHead>{showCost && <TableHead className="text-right">Value in transit</TableHead>}</TableRow></TableHeader>
              <TableBody>
                {trip.lines.map((x) => (
                  <TableRow key={x.id}>
                    <TableCell>{lname(x.transfer_line_id)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(N(x.qty))}</TableCell>
                    <TableCell className="text-right tabular-nums">{x.net_kg == null ? "—" : formatQuantity(N(x.net_kg))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(N(x.qty_reported))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(N(x.qty_accepted))}</TableCell>
                    <TableCell className="text-right tabular-nums">{N(x.qty_quarantined) ? formatQuantity(N(x.qty_quarantined)) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{N(x.qty_short) ? formatQuantity(N(x.qty_short)) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(N(x.qty) - N(x.qty_reported))}</TableCell>
                    {showCost && <TableCell className="text-right tabular-nums">{formatMoney(N(x.transit_value))}</TableCell>}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {tripReceipts.map((r) => (
              <div key={r.id} className="rounded-md border border-border p-3">
                <p className="text-xs font-medium">{r.document_number} · arrived {r.arrived_at ? formatDateTime(r.arrived_at) : "—"} · recorded {formatDateTime(r.received_at)}{r.signed_by_name && ` · signed by ${r.signed_by_name}`}</p>
                {r.lines.map((rl) => {
                  const openQ = N(rl.qty_damaged) - N(rl.qty_released) - N(rl.qty_resolved_damaged);
                  const openS = N(rl.qty_short) - N(rl.qty_resolved_short);
                  return (
                    <div key={rl.id} className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span>{lname(rl.transfer_line_id)}: {formatQuantity(N(rl.qty_received))} accepted{N(rl.qty_damaged) ? `, ${formatQuantity(N(rl.qty_damaged))} quarantined` : ""}{N(rl.qty_short) ? `, ${formatQuantity(N(rl.qty_short))} short` : ""}
                        {showCost && ` · ${formatMoney(N(rl.value))}`}
                        {rl.resolutions.map((x, i) => <span key={i} className="ml-2 text-muted-foreground">[{x.kind} {formatQuantity(N(x.qty))} → {x.resolution.replace("_", " ")}]</span>)}</span>
                      <span className="flex gap-1">
                        <ResolveButton receiptLineId={rl.id} kind="quarantine" open={openQ} canResolve={canResolve} canFound={false} />
                        <ResolveButton receiptLineId={rl.id} kind="short" open={openS} canResolve={canResolve} canFound={canReceive} />
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
            {trip.changes.length > 0 && (
              <div className="text-xs text-muted-foreground">
                <p className="font-medium text-foreground">Transport changes</p>
                {trip.changes.map((c, i) => <p key={i}>{formatDateTime(c.changed_at)}: {Object.keys(c.new_values).filter((k) => canLicence || k !== "driver_licence").map((k) => `${k.replace(/_/g, " ")} ${c.old_values[k] ?? "—"} → ${c.new_values[k] ?? "—"}`).join("; ")} — {c.reason}</p>)}
              </div>
            )}
            {trip.void_reason && <p className="text-xs text-muted-foreground">Voided: {trip.void_reason}</p>}
            {attachmentsOn && trip.status !== "draft" && <AttachmentsPanel ownerType="stock_transfer_dispatch" ownerId={trip.id} categories={tripCats} />}
          </CardContent></Card>
        );
      })}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card><CardContent className="space-y-2 p-5 text-sm">
          <h3 className="font-semibold">Agents</h3>
          {((agents ?? []) as { id: string; name: string; company_name: string | null; phone: string | null; role: string | null }[]).map((a) => (
            <p key={a.id}>{a.name}{a.role && <span className="text-muted-foreground"> ({a.role})</span>}{a.company_name && `, ${a.company_name}`}{a.phone && <> · <a className="underline" href={`tel:${a.phone}`}>{a.phone}</a></>}</p>
          ))}
          {(agents ?? []).length === 0 && <p className="text-muted-foreground">None.</p>}
          {logistics && t.status !== "voided" && <AddAgentForm transferId={id} />}
        </CardContent></Card>
        <Card><CardContent className="space-y-2 p-5 text-sm">
          <h3 className="font-semibold">Timeline</h3>
          {logistics && t.status !== "voided" && <AddUpdateForm transferId={id} trips={tripOpts.filter((x) => !x.label.includes("draft"))} />}
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {((events ?? []) as { id: string; event_type: string; note: string | null; created_at: string }[]).map((e) => (
              <p key={e.id} className="text-xs"><span className="text-muted-foreground">{formatDateTime(e.created_at)}</span> · {e.note ?? e.event_type.replace(/_/g, " ")}</p>
            ))}
            {(events ?? []).length === 0 && <p className="text-xs text-muted-foreground">No updates yet.</p>}
          </div>
        </CardContent></Card>
      </div>

      {showCost && logistics && !legacy && (
        <Card><CardContent className="space-y-2 p-5 text-sm">
          <h3 className="font-semibold">Transfer charges (TZS)</h3>
          <p className="text-xs text-muted-foreground">Loading, transport, offloading and other charges. Estimates post nothing; accruals and supplier invoices (Importation → Cost Invoices) are added to the cargo by net kg unless set otherwise, and follow the goods after receipt.</p>
          {((charges ?? []) as unknown as { id: string; description: string | null; status: string; estimated_amount: number; accrued_amount: number; actual_amount: number; allocation_basis: string | null;
            inventory_treatment: string; transfer_dispatch_id: string | null; category: { name: string } | null }[]).map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1 last:border-0">
              <span>{c.category?.name}{c.description && ` — ${c.description}`} <span className="text-xs text-muted-foreground">({c.transfer_dispatch_id ? tripOpts.find((x) => x.id === c.transfer_dispatch_id)?.label ?? "trip" : "whole transfer"} · {c.inventory_treatment === "capitalize" ? `by ${c.allocation_basis === "weight" || !c.allocation_basis ? "net kg" : c.allocation_basis}` : "expensed"} · {c.status})</span></span>
              <span className="flex items-center gap-2 tabular-nums">{formatMoney(N(c.status === "invoiced" ? c.actual_amount : c.status === "accrued" ? c.accrued_amount : c.estimated_amount))}
                <ChargeRowActions sourceId={c.id} status={c.status} estimate={N(c.estimated_amount)} canAccrue={can(ctx.user, "inventory.transfer_cost")} /></span>
            </div>
          ))}
          {t.status !== "voided" && <ChargeForm transferId={id} trips={tripOpts.filter((x) => !x.label.includes("draft"))}
            categories={(categories ?? []).map((c) => ({ id: c.id, label: `${c.code} — ${c.name}`, capitalise: c.inventory_treatment === "capitalize" }))} />}
        </CardContent></Card>
      )}

      {attachmentsOn && (
        <Card><CardContent className="p-5">
          <h3 className="mb-2 text-sm font-semibold">Transfer documents</h3>
          <AttachmentsPanel ownerType="stock_transfer" ownerId={id} categories={["cargo_papers", "delivery_note", "proof_of_delivery", "photo", "other"]} />
        </CardContent></Card>
      )}
    </div>
  );
}
