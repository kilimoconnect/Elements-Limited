import { assertActiveUser } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { isHeadOfficeUser, transferGrnGroups } from "@/lib/transfers/grn-data";
import { renderTransferGrn, type GrnData } from "@/lib/transfers/grn";
import { toAmendments } from "@/lib/pdf/brand";
import { canUseLicenceNumber } from "@/lib/transfers/licence";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * GET the GRN PDF for one supplier's goods on a transfer (`supplier` = its id,
 * or "none" for goods with no recorded supplier). Head Office only. The first
 * download gives it a GRN number; later downloads keep it. Posts nothing.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; supplier: string }> }) {
  const { id, supplier } = await ctx.params;
  let user;
  try { user = await assertActiveUser(); } catch { return new Response("Not signed in.", { status: 401 }); }
  const notFound = new Response("Not found.", { status: 404 });
  if (!UUID.test(id) || (supplier !== "none" && !UUID.test(supplier))) return notFound;
  if (!userHasPermission(user, "inventory.transfer_view")) return notFound;

  const admin = createAdminClient();
  const { data: t } = await admin.from("stock_transfers")
    .select("id, company_id, document_number, transfer_date, reference, status, source:branches!stock_transfers_source_branch_id_fkey(code,name), dest:branches!stock_transfers_destination_branch_id_fkey(code,name,address)")
    .eq("id", id).maybeSingle();
  if (!t || (!user.isOwner && !user.companyIds.includes(t.company_id))) return notFound;
  if (!(await isHeadOfficeUser(user, t.company_id))) return new Response("Only Head Office can issue GRNs.", { status: 403 });

  const supplierId = supplier === "none" ? null : supplier;
  const group = (await transferGrnGroups(id)).find((g) => g.supplierId === supplierId);
  if (!group) return notFound;

  const { data: num, error } = await admin.rpc("issue_transfer_grn", { p_transfer: id, p_supplier: supplierId, p_user: user.id });
  if (error) return new Response(error.message.replace(/^ERROR:\s*/i, ""), { status: 400 });
  const { data: grn } = await admin.from("transfer_grns").select("created_at").eq("company_id", t.company_id).eq("document_number", num as string).single();

  const [{ data: company }, { data: sup }, { data: lines }, { data: trips }] = await Promise.all([
    admin.from("companies").select("name, legal_name, address, phone, email").eq("id", t.company_id).single(),
    supplierId
      ? admin.from("suppliers").select("code, name, contact_person, phone, email, tin, vat_number, address, payment_terms_days").eq("id", supplierId).single()
      : Promise.resolve({ data: null }),
    admin.from("stock_transfer_lines").select("id, qty_requested, qty_dispatched, qty_received, kg_per_unit, batch_reference, product:products(sku, name, unit:units(code))")
      .in("id", group.lineIds).order("line_no"),
    admin.from("stock_transfer_dispatches").select("trip_no, delivery_note_number, status, vehicle_registration, trailer_registration, driver_name, driver_phone, driver_licence, changes:stock_transfer_dispatch_changes(old_values, new_values, reason, changed_at)").eq("transfer_id", id).order("trip_no"),
  ]);

  type Line = { qty_requested: number; qty_dispatched: number; qty_received: number; kg_per_unit: number | null; batch_reference: string | null;
    product: { sku: string; name: string; unit: { code: string } | null } | null };
  const src = t.source as unknown as { code: string; name: string };
  const dst = t.dest as unknown as { code: string; name: string; address: string | null };
  const data: GrnData = {
    number: num as string, issued_at: grn?.created_at ?? new Date().toISOString(),
    company: company!, supplier: sup,
    transfer: { number: t.document_number, date: t.transfer_date, reference: t.reference, status: t.status },
    from: src, to: dst,
    delivery_notes: ((trips ?? []) as { delivery_note_number: string | null; status: string }[])
      .filter((x) => x.status !== "voided" && x.delivery_note_number).map((x) => x.delivery_note_number!),
    // Truck and driver of every trip (no transporter); the licence number only for users allowed to see it.
    trucks: ((trips ?? []) as { trip_no: number; status: string; vehicle_registration: string | null; trailer_registration: string | null;
      driver_name: string | null; driver_phone: string | null; driver_licence: string | null }[])
      .filter((x) => x.status !== "voided")
      .map((x) => ({ trip_no: x.trip_no, truck: x.vehicle_registration, trailer: x.trailer_registration, driver: x.driver_name,
        phone: x.driver_phone, licence: canUseLicenceNumber(user) ? x.driver_licence : null })),
    amendments: toAmendments(((trips ?? []) as unknown as { trip_no: number; status: string; changes: { old_values: Record<string, unknown>; new_values: Record<string, unknown>; reason: string; changed_at: string }[] }[])
      .filter((x) => x.status !== "voided").flatMap((x) => (x.changes ?? []).map((c) => ({ ...c, trip: x.trip_no }))), canUseLicenceNumber(user)),
    lines: ((lines ?? []) as unknown as Line[]).map((l) => {
      const sent = Number(l.qty_dispatched) || Number(l.qty_requested);
      return {
        sku: l.product?.sku ?? "", name: l.product?.name ?? "", unit: l.product?.unit?.code ?? null, batch: l.batch_reference,
        sent, received: Number(l.qty_received), net_kg: l.kg_per_unit ? Math.round(sent * Number(l.kg_per_unit) * 10000) / 10000 : null,
      };
    }),
  };

  await writeAuditLog({ userId: user.id, companyId: t.company_id, action: "transfer.grn_download", resourceType: "stock_transfer", resourceId: id, newValues: { grn: num, supplier_id: supplierId } });
  const name = `${num}.pdf`.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(new Blob([renderTransferGrn(data) as BlobPart], { type: "application/pdf" }), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
