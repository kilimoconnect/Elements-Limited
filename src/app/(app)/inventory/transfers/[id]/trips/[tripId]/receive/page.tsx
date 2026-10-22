import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ReceiveTripForm } from "./receive-form";

export const metadata: Metadata = { title: "Receive Trip" };
type Params = Promise<{ id: string; tripId: string }>;
const N = (v: unknown) => Number(v ?? 0);

export default async function ReceiveTripPage(props: { params: Params }) {
  await requirePermissionPage("inventory.transfer_receive");
  const ctx = await getActiveContext();
  const { id, tripId } = await props.params;
  const admin = createAdminClient();
  const { data: t } = await admin.from("stock_transfers").select("id, company_id, destination_branch_id, document_number").eq("id", id).maybeSingle();
  if (!t || t.company_id !== ctx.companyId || !(ctx.user.isOwner || ctx.user.branchIds.includes(t.destination_branch_id))) notFound();
  const { data: trip } = await admin.from("stock_transfer_dispatches")
    .select("id, transfer_id, status, document_number, driver_name, vehicle_registration, lines:stock_transfer_dispatch_lines(id, qty, qty_reported, transfer_line:stock_transfer_lines(product:products(sku, name)))")
    .eq("id", tripId).maybeSingle();
  if (!trip || trip.transfer_id !== id) notFound();
  const lines = ((trip.lines ?? []) as unknown as { id: string; qty: number; qty_reported: number; transfer_line: { product: { sku: string; name: string } | null } | null }[])
    .map((l) => ({ id: l.id, label: `${l.transfer_line?.product?.sku} — ${l.transfer_line?.product?.name}`, open: Math.max(N(l.qty) - N(l.qty_reported), 0) }))
    .filter((l) => l.open > 0);
  return (
    <div>
      <PageHeader title={`Receive ${trip.document_number ?? "trip"}`} description={`Driver ${trip.driver_name ?? "—"} · ${trip.vehicle_registration ?? "—"}. Record what actually arrived: accepted goods enter stock; quarantined and short cargo stay in transit until resolved.`} />
      {!["dispatched", "arrived"].includes(trip.status) || lines.length === 0 ? <EmptyState title="Nothing left to receive on this trip" /> :
        <ReceiveTripForm transferId={id} tripId={tripId} lines={lines} />}
    </div>
  );
}
