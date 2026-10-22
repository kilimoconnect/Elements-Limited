import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { TripForm } from "./trip-form";

export const metadata: Metadata = { title: "New Dispatch Trip" };
type Params = Promise<{ id: string }>;
const N = (v: unknown) => Number(v ?? 0);

export default async function NewTripPage(props: { params: Params }) {
  await requirePermissionPage("inventory.transfer_dispatch");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();
  const { data: t } = await admin.from("stock_transfers").select("id, company_id, source_branch_id, document_number, status, posts_in_transit, expected_date, driver_name, driver_phone, vehicle_registration, trailer_registration").eq("id", id).maybeSingle();
  if (!t || t.company_id !== ctx.companyId || !(ctx.user.isOwner || ctx.user.branchIds.includes(t.source_branch_id))) notFound();
  const [{ data: lines }, { data: drafts }] = await Promise.all([
    admin.from("stock_transfer_lines").select("id, qty_requested, qty_dispatched, kg_per_unit, product:products(sku, name, stock_role, net_weight_kg)").eq("transfer_id", id).order("line_no"),
    admin.from("stock_transfer_dispatches").select("lines:stock_transfer_dispatch_lines(transfer_line_id, qty)").eq("transfer_id", id).eq("status", "draft"),
  ]);
  const inDraft = new Map<string, number>();
  for (const d of (drafts ?? []) as unknown as { lines: { transfer_line_id: string; qty: number }[] }[]) for (const l of d.lines) inDraft.set(l.transfer_line_id, (inDraft.get(l.transfer_line_id) ?? 0) + N(l.qty));
  const open = ((lines ?? []) as unknown as { id: string; qty_requested: number; qty_dispatched: number; product: { sku: string; name: string; stock_role: string; net_weight_kg: number | null } | null }[])
    .map((l) => ({ id: l.id, label: `${l.product?.sku} — ${l.product?.name}`, remaining: Math.max(N(l.qty_requested) - N(l.qty_dispatched) - (inDraft.get(l.id) ?? 0), 0),
      kgPerUnit: l.product?.stock_role === "bulk" ? 1 : l.product?.net_weight_kg ? N(l.product.net_weight_kg) : null }))
    .filter((l) => l.remaining > 0);
  return (
    <div>
      <PageHeader title={`New trip · ${t.document_number ?? "transfer"}`} description="One truck: its cargo, driver and vehicle. Several trips can carry one transfer." />
      {!t.posts_in_transit || t.status === "voided" ? <EmptyState title="This transfer cannot take new trips" /> :
        open.length === 0 ? <EmptyState title="Everything requested is already on a trip" /> : (
          <TripForm transferId={id} lines={open} canLicence={can(ctx.user, "documents.view_licence")}
            defaults={{ driverName: t.driver_name ?? "", driverPhone: t.driver_phone ?? "", vehicle: t.vehicle_registration ?? "", trailer: t.trailer_registration ?? "", expected: t.expected_date ?? "" }} />
        )}
    </div>
  );
}
