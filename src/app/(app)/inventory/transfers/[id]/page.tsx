import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
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
import { ChangeRouteButton } from "./change-route";
import { isHeadOfficeUser, transferGrnGroups } from "@/lib/transfers/grn-data";
import { canUseLicenceNumber } from "@/lib/transfers/licence";
import { TripActions, ResolveButton, ChargeForm, ChargeRowActions, ChangeQuantityButton } from "./transfer-file";

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
  // Licence numbers: dispatchers and licence viewers; licence photos: licence viewers only.
  const canLicence = canUseLicenceNumber(ctx.user);
  const canLicencePhoto = can(ctx.user, "documents.view_licence");
  const canResolve = can(ctx.user, "inventory.transfer_resolve") && isReceiver;
  const canReceive = can(ctx.user, "inventory.transfer_receive") && isReceiver;
  const canDispatch = can(ctx.user, "inventory.transfer_dispatch") && isSender;
  const logistics = await isFeatureEnabled(ctx.companyId, "transfer_logistics");
  const attachmentsOn = await isFeatureEnabled(ctx.companyId, "attachments");
  const headOffice = await isHeadOfficeUser(ctx.user, ctx.companyId);
  const grnGroups = headOffice && t.status !== "voided" ? await transferGrnGroups(id) : [];

  const [{ data: lines }, { data: trips }, { data: receipts }, { data: charges }, { data: categories }] = await Promise.all([
    admin.from("stock_transfer_lines").select("id, line_no, qty_requested, qty_dispatched, qty_received, qty_quarantined, qty_short_pending, qty_lost_normal, qty_lost_abnormal, unit_cost, transit_value, received_value, lost_value, charges_applied, batch_reference, kg_per_unit, product:products(sku,name)").eq("transfer_id", id).order("line_no"),
    admin.from("stock_transfer_dispatches").select("*, lines:stock_transfer_dispatch_lines(id, transfer_line_id, qty, net_kg, value, transit_value, qty_reported, qty_accepted, qty_quarantined, qty_short, qty_lost_normal, qty_lost_abnormal), changes:stock_transfer_dispatch_changes(old_values, new_values, reason, changed_at)").eq("transfer_id", id).order("trip_no"),
    admin.from("stock_transfer_receipts").select("id, document_number, dispatch_id, arrived_at, received_at, signed_by_name, notes, lines:stock_transfer_receipt_lines(id, transfer_line_id, qty_received, qty_damaged, qty_short, qty_released, qty_resolved_damaged, qty_resolved_short, value, resolutions:stock_transfer_resolutions(kind, resolution, qty, value, created_at))").eq("transfer_id", id).order("received_at"),
    showCost ? admin.from("cost_sources").select("id, description, status, estimated_amount, accrued_amount, actual_amount, allocation_basis, inventory_treatment, transfer_dispatch_id, category:cost_categories(name)").eq("stock_transfer_id", id).neq("status", "voided").order("created_at") : Promise.resolve({ data: [] }),
    admin.from("cost_categories").select("id, code, name, inventory_treatment").eq("company_id", ctx.companyId).eq("is_active", true).eq("applies_to_transfer", true).order("code"),
  ]);
  type L = { id: string; line_no: number; qty_requested: number; qty_dispatched: number; qty_received: number; qty_quarantined: number; qty_short_pending: number;
    qty_lost_normal: number; qty_lost_abnormal: number; unit_cost: number; transit_value: number; received_value: number; lost_value: number; charges_applied: number;
    batch_reference: string | null; kg_per_unit: number | null; product: { sku: string; name: string } | null };
  const ls = (lines ?? []) as unknown as L[];
  type Trip = Record<string, unknown> & { id: string; trip_no: number; status: string; document_number: string | null; delivery_note_number: string | null; driver_name: string | null; driver_phone: string | null;
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
  // Quantities can change until goods arrive (sending branch, dispatch permission).
  const canQty = isSender && (can(ctx.user, "inventory.transfer_dispatch") || can(ctx.user, "inventory.transfer_quantity"));
  const canChangeQty = canQty && t.status !== "voided" && (!legacy || t.status === "draft");
  const canChangeTrip = (trip: { status: string }, x: { qty_reported: number }) =>
    canQty && !legacy && (trip.status === "draft" || (trip.status === "dispatched" && N(x.qty_reported) === 0));
  // Route (destination) can change until anything arrives or is received.
  const canChangeRoute = canDispatch && ["draft", "dispatched"].includes(t.status) && rcs.length === 0
    && !tripsList.some((x) => x.status === "arrived" || x.status === "received");
  const routeBranches = canChangeRoute
    ? ((await admin.from("branches").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("name")).data ?? [])
        .filter((b) => b.id !== t.source_branch_id && b.id !== t.destination_branch_id)
    : [];
  const tripCats: AttachmentCategory[] = ["loading_photo", "cargo_papers", "weighbridge_ticket", "signed_delivery_note", "offloading_photo", "other",
    ...(canLicencePhoto ? ["driver_licence" as const] : []), ...(can(ctx.user, "documents.view_financial") ? ["transport_invoice" as const] : [])];

  return (
    <div className="space-y-4">
      <Button asChild variant="outline" size="sm"><Link href="/inventory/transfers"><ArrowLeft className="h-4 w-4" /> Back to transfers</Link></Button>
      <PageHeader
        title={t.document_number ?? "Transfer (draft)"}
        description={`${t.source?.code} — ${t.source?.name} → ${t.dest?.code} — ${t.dest?.name}${isSender && isReceiver ? "" : isSender ? " · you are the sending branch" : " · you are the receiving branch"}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {canChangeRoute && routeBranches.length > 0 && (
              <ChangeRouteButton transferId={id} current={`${t.dest?.name ?? ""}`} branches={routeBranches} dispatched={t.status === "dispatched"} />
            )}
            {logistics && !legacy && canDispatch && remainingToDispatch && t.status !== "voided" &&
              <Button asChild variant="outline"><Link href={`/inventory/transfers/${id}/trips/new`}>New dispatch trip</Link></Button>}
            <TransferActions id={id} status={t.status} lines={tLines}
              canDispatch={canDispatch && tripsList.length === 0} canReceive={canReceive && (legacy || tripsList.length <= 1)} canVoid={can(ctx.user, "transactions.void")} />
          </div>
        }
      />

      <Card><CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 text-sm sm:flex sm:flex-wrap sm:gap-x-8 sm:p-5">
        <div><p className="text-xs uppercase text-muted-foreground">Status</p><DocStatusBadge status={t.status} />{t.has_open_discrepancy && <Badge variant="warning" className="ml-1">open discrepancy</Badge>}</div>
        <div><p className="text-xs uppercase text-muted-foreground">Costing</p><p>{t.cost_status}</p></div>
        <div><p className="text-xs uppercase text-muted-foreground">Date</p><p>{formatDate(t.transfer_date)}</p></div>
        <div><p className="text-xs uppercase text-muted-foreground">Warehouses</p><p>{t.source_location ?? "—"} → {t.destination_location ?? "—"}</p></div>
        <div><p className="text-xs uppercase text-muted-foreground">Reference</p><p>{t.reference ?? "—"}</p></div>
        {legacy && <div><p className="text-xs uppercase text-muted-foreground">Engine</p><p>Dispatched before the upgrade (no trips)</p></div>}
        {t.void_reason && <div><p className="text-xs uppercase text-muted-foreground">Void reason</p><p>{t.void_reason}</p></div>}
      </CardContent></Card>

      <div className="space-y-2 md:hidden">
        {ls.map((r) => {
          const lost = N(r.qty_lost_normal) + N(r.qty_lost_abnormal);
          const out = N(r.qty_dispatched) - N(r.qty_received) - N(r.qty_quarantined) - N(r.qty_short_pending) - lost;
          return (
            <Card key={r.id}><CardContent className="space-y-2 p-4 text-sm">
              <p className="font-medium leading-snug">{r.product?.name}</p>
              <p className="font-mono text-xs text-muted-foreground">{r.product?.sku}{r.batch_reference && ` · Batch ${r.batch_reference}`}</p>
              <Stats rows={[
                ["Requested", formatQuantity(N(r.qty_requested))], ["Dispatched", formatQuantity(N(r.qty_dispatched))],
                ["Accepted", formatQuantity(N(r.qty_received))], ["Outstanding", formatQuantity(legacy ? N(r.qty_dispatched) - N(r.qty_received) : Math.max(out, 0)), true],
                ...(N(r.qty_quarantined) ? [["Quarantined", formatQuantity(N(r.qty_quarantined))] as Stat] : []),
                ...(N(r.qty_short_pending) ? [["Short (open)", formatQuantity(N(r.qty_short_pending))] as Stat] : []),
                ...(lost ? [["Lost", formatQuantity(lost)] as Stat] : []),
                ["Net kg dispatched", r.kg_per_unit ? formatQuantity(N(r.qty_dispatched) * N(r.kg_per_unit)) : "—"],
                ...(showCost ? [["In transit", formatMoney(legacy ? (N(r.qty_dispatched) - N(r.qty_received)) * N(r.unit_cost) : N(r.transit_value))] as Stat,
                  ["Received value", formatMoney(N(r.received_value))] as Stat, ["Charges", formatMoney(N(r.charges_applied))] as Stat] : []),
              ]} />
              {canChangeQty && <p className="text-xs">Requested quantity <ChangeQuantityButton kind="line" id={r.id} current={N(r.qty_requested)} label={`${r.product?.sku} — ${r.product?.name}`} /></p>}
            </CardContent></Card>
          );
        })}
      </div>

      <span id="quantities" className="block scroll-mt-20" />
      {canChangeQty && <p className="text-xs text-muted-foreground">Use <span className="font-medium text-foreground">Change</span> next to Requested, or next to Loaded on a trip below: requested and loaded change together.</p>}
      <Card className="hidden overflow-x-auto md:block">
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
                  <TableCell className="whitespace-nowrap text-right tabular-nums">{formatQuantity(N(r.qty_requested))}{canChangeQty && <ChangeQuantityButton kind="line" id={r.id} current={N(r.qty_requested)} label={`${r.product?.sku} — ${r.product?.name}`} />}</TableCell>
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

      {grnGroups.length > 0 && (
        <Card><CardContent className="space-y-3 p-5 text-sm">
          <div>
            <h3 className="font-semibold">Goods Received Notes (Head Office)</h3>
            <p className="text-xs text-muted-foreground">One GRN per supplier of the goods on this transfer, with the supplier’s details, to submit to the supplier. The GRN number is given on the first download and kept.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {grnGroups.map((g) => (
              <Button key={g.key} asChild variant="outline" size="sm" className="h-auto min-h-8 whitespace-normal py-1.5 text-left">
                <a href={`/api/transfers/${id}/grn/${g.supplierId ?? "none"}`}>
                  GRN{g.number ? ` ${g.number}` : ""} — {g.supplierName} ({g.lineIds.length} {g.lineIds.length === 1 ? "product" : "products"})
                </a>
              </Button>
            ))}
          </div>
        </CardContent></Card>
      )}

      {tripsList.map((trip) => {
        const tripReceipts = rcs.filter((r) => r.dispatch_id === trip.id);
        return (
          <Card key={trip.id}><CardContent className="space-y-3 p-4 text-sm sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold">{trip.document_number ?? `Trip ${trip.trip_no} (draft)`} <Badge variant={trip.status === "received" ? "success" : trip.status === "voided" ? "secondary" : "warning"}>{trip.status}</Badge></h3>
                <p className="text-xs text-muted-foreground">Dispatch {trip.dispatched_at ? formatDateTime(trip.dispatched_at) : formatDate(trip.dispatch_date)} · ETA {trip.expected_arrival_at ? formatDateTime(trip.expected_arrival_at) : "—"} · Arrived {trip.arrived_at ? formatDateTime(trip.arrived_at) : "—"}</p>
              </div>
              <TripActions transferId={id} tripId={trip.id} status={trip.status} isSender={canDispatch} isReceiver={canReceive} canVoid={can(ctx.user, "transactions.void")} canLicence={canLicence}
                transport={{ driver_name: trip.driver_name ?? "", driver_phone: trip.driver_phone ?? "", ...(canLicence ? { driver_licence: trip.driver_licence ?? "" } : {}),
                  vehicle_registration: trip.vehicle_registration ?? "", trailer_registration: trip.trailer_registration ?? "", transporter_name: trip.transporter_name ?? "", transporter_contact: trip.transporter_contact ?? "" }} />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div><p className="text-xs text-muted-foreground">Driver</p><p>{trip.driver_name ?? "—"}{trip.driver_phone && <> · <a className="underline" href={`tel:${trip.driver_phone}`}>{trip.driver_phone}</a></>}</p>
                {canLicence && trip.driver_licence && <p className="text-xs text-muted-foreground">Licence {trip.driver_licence}</p>}</div>
              <div><p className="text-xs text-muted-foreground">Truck / trailer</p><p>{trip.vehicle_registration ?? "—"} / {trip.trailer_registration ?? "—"}</p></div>
              <div><p className="text-xs text-muted-foreground">Transporter</p><p>{trip.transporter_name ?? "—"}{trip.transporter_contact && <> · {trip.transporter_contact}</>}</p></div>
            </div>
            <div className="space-y-2 md:hidden">
              {trip.lines.map((x) => (
                <div key={x.id} className="rounded-md border border-border p-3">
                  <p className="mb-2 font-medium leading-snug">{lname(x.transfer_line_id)}</p>
                  <Stats rows={[
                    ["Loaded", formatQuantity(N(x.qty))], ["Net kg", x.net_kg == null ? "—" : formatQuantity(N(x.net_kg))],
                    ["Arrived", formatQuantity(N(x.qty_reported))], ["Accepted", formatQuantity(N(x.qty_accepted))],
                    ...(N(x.qty_quarantined) ? [["Quarantined", formatQuantity(N(x.qty_quarantined))] as Stat] : []),
                    ...(N(x.qty_short) ? [["Short", formatQuantity(N(x.qty_short))] as Stat] : []),
                    ["To arrive", formatQuantity(N(x.qty) - N(x.qty_reported)), true],
                    ...(showCost ? [["Value in transit", formatMoney(N(x.transit_value))] as Stat] : []),
                  ]} />
                  {canChangeTrip(trip, x) && <p className="pt-1 text-xs">Loaded quantity <ChangeQuantityButton kind="trip" id={x.id} current={N(x.qty)} label={lname(x.transfer_line_id)} dispatched={trip.status === "dispatched"} /></p>}
                </div>
              ))}
            </div>
            <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader><TableRow><TableHead>Cargo</TableHead><TableHead className="text-right">Loaded</TableHead><TableHead className="text-right">Net kg</TableHead>
                <TableHead className="text-right">Arrived</TableHead><TableHead className="text-right">Accepted</TableHead><TableHead className="text-right">Quarantined</TableHead><TableHead className="text-right">Short</TableHead>
                <TableHead className="text-right">To arrive</TableHead>{showCost && <TableHead className="text-right">Value in transit</TableHead>}</TableRow></TableHeader>
              <TableBody>
                {trip.lines.map((x) => (
                  <TableRow key={x.id}>
                    <TableCell>{lname(x.transfer_line_id)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{formatQuantity(N(x.qty))}{canChangeTrip(trip, x) && <ChangeQuantityButton kind="trip" id={x.id} current={N(x.qty)} label={lname(x.transfer_line_id)} dispatched={trip.status === "dispatched"} />}</TableCell>
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
            </div>
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


      {showCost && logistics && !legacy && (
        <Card><CardContent className="space-y-2 p-4 text-sm sm:p-5">
          <h3 className="font-semibold">Transfer charges (TZS)</h3>
          <p className="text-xs text-muted-foreground">Loading, transport, offloading and other charges. Posted with its supplier, a charge is owed to that supplier (Accounts Payable) and is added to the cargo by net kg unless set otherwise; it follows the goods after receipt. Estimates post nothing.</p>
          {((charges ?? []) as unknown as { id: string; description: string | null; status: string; estimated_amount: number; accrued_amount: number; actual_amount: number; allocation_basis: string | null;
            inventory_treatment: string; transfer_dispatch_id: string | null; category: { name: string } | null }[]).map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1 last:border-0">
              <span>{c.category?.name}{c.description && ` — ${c.description}`} <span className="text-xs text-muted-foreground">({c.transfer_dispatch_id ? tripOpts.find((x) => x.id === c.transfer_dispatch_id)?.label ?? "trip" : "whole transfer"} · {c.inventory_treatment === "capitalize" ? `by ${c.allocation_basis === "weight" || !c.allocation_basis ? "net kg" : c.allocation_basis}` : "expensed"} · {c.status})</span></span>
              <span className="flex items-center gap-2 tabular-nums">{formatMoney(N(c.status === "invoiced" ? c.actual_amount : c.status === "accrued" ? c.accrued_amount : c.estimated_amount))}
                <ChargeRowActions sourceId={c.id} status={c.status} estimate={N(c.estimated_amount)} canAccrue={can(ctx.user, "inventory.transfer_cost")} /></span>
            </div>
          ))}
          {t.status !== "voided" && <ChargeForm transferId={id} branchId={t.source_branch_id} trips={tripOpts.filter((x) => !x.label.includes("draft"))}
            canPostInvoice={can(ctx.user, "cost_invoices.post")}
            suppliers={((await admin.from("suppliers").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("name")).data ?? [])}
            categories={(categories ?? []).map((c) => ({ id: c.id, label: `${c.code} — ${c.name}`, capitalise: c.inventory_treatment === "capitalize" }))} />}
        </CardContent></Card>
      )}

    </div>
  );
}

type Stat = [label: string, value: string, strong?: boolean];
/** Label / value pairs for the phone layout (two columns). */
function Stats({ rows }: { rows: Stat[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
      {rows.map(([k, v, strong]) => (
        <div key={k} className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className={`tabular-nums ${strong ? "font-semibold" : ""}`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
