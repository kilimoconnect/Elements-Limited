import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { BulkReceiveForm, type InTransitTruck } from "./bulk-receive-form";

export const metadata: Metadata = { title: "Receive Trucks" };
const N = (v: unknown) => Number(v ?? 0);

/** Receiving branch: every truck in transit to my branches, received several at once. */
export default async function BulkReceivePage() {
  await requirePermissionPage("inventory.transfer_receive");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const mine = ctx.user.isOwner ? ctx.branches.map((b) => b.id) : ctx.user.branchIds;
  const none = ["00000000-0000-0000-0000-000000000000"];
  const { data } = await admin.from("stock_transfer_dispatches")
    .select(`id, trip_no, status, document_number, delivery_note_number, vehicle_registration, trailer_registration, driver_name, driver_phone, dispatched_at, expected_arrival_at,
      transfer:stock_transfers!inner(id, document_number, status, destination_branch_id, source:branches!stock_transfers_source_branch_id_fkey(name), dest:branches!stock_transfers_destination_branch_id_fkey(name)),
      lines:stock_transfer_dispatch_lines(id, qty, qty_reported, transfer_line:stock_transfer_lines(product:products(sku, name, unit:units(symbol))))`)
    .eq("company_id", ctx.companyId).in("status", ["dispatched", "arrived"]).neq("transfer.status", "voided")
    .in("transfer.destination_branch_id", mine.length ? mine : none)
    .order("dispatched_at", { ascending: true }).limit(500);
  type Raw = {
    id: string; trip_no: number; status: string; document_number: string | null; delivery_note_number: string | null;
    vehicle_registration: string | null; trailer_registration: string | null; driver_name: string | null; driver_phone: string | null;
    dispatched_at: string | null; expected_arrival_at: string | null;
    transfer: { id: string; document_number: string | null; destination_branch_id: string; source: { name: string } | null; dest: { name: string } | null } | null;
    lines: { id: string; qty: number; qty_reported: number; transfer_line: { product: { sku: string; name: string; unit: { symbol: string } | null } | null } | null }[];
  };
  const trucks: InTransitTruck[] = ((data ?? []) as unknown as Raw[]).filter((r) => r.transfer).map((r) => ({
    id: r.id, transferId: r.transfer!.id, transfer: r.transfer!.document_number ?? "Transfer", trip: r.document_number ?? `Trip ${r.trip_no}`,
    deliveryNote: r.delivery_note_number, from: r.transfer!.source?.name ?? "", to: r.transfer!.dest?.name ?? "", toId: r.transfer!.destination_branch_id,
    vehicle: r.vehicle_registration, trailer: r.trailer_registration, driver: r.driver_name, driverPhone: r.driver_phone,
    dispatchedAt: r.dispatched_at, eta: r.expected_arrival_at,
    lines: r.lines.map((l) => ({
      id: l.id, name: l.transfer_line?.product?.name ?? l.transfer_line?.product?.sku ?? "—", unit: l.transfer_line?.product?.unit?.symbol ?? "",
      open: Math.max(N(l.qty) - N(l.qty_reported), 0),
    })).filter((l) => l.open > 0),
  })).filter((t) => t.lines.length > 0);
  const [{ data: categories }, chargesEnabled] = await Promise.all([
    admin.from("cost_categories").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true)
      .eq("applies_to_transfer", true).eq("inventory_treatment", "capitalize").order("code"),
    isFeatureEnabled(ctx.companyId, "transfer_logistics"),
  ]);
  const branches = [...new Map(trucks.map((t) => [t.toId, t.to])).entries()].map(([id, name]) => ({ id, name }));

  return (
    <div className="space-y-4">
      <Button asChild variant="outline" size="sm"><Link href="/inventory/transfers"><ArrowLeft className="h-4 w-4" /> Back to transfers</Link></Button>
      <PageHeader title="Receive Trucks"
        description="Tick the trucks that arrived, check the quantity received on each, then confirm. Each truck is recorded as its own receipt, exactly as when received one by one." />
      {trucks.length === 0 ? <EmptyState title="No trucks in transit to your branches" description="Trucks appear here once the sending branch confirms loading." />
        : <BulkReceiveForm trucks={trucks} branches={branches} chargesEnabled={chargesEnabled}
            categories={(categories ?? []).map((c) => ({ id: c.id, code: c.code, name: c.name }))} />}
    </div>
  );
}
