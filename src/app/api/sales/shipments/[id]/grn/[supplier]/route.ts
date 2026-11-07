import { assertActiveUser } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { isHeadOfficeUser, salesShipmentGrnGroups } from "@/lib/transfers/grn-data";
import { renderTransferGrn, type GrnData } from "@/lib/transfers/grn";
import { canUseLicenceNumber } from "@/lib/transfers/licence";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * GET the GRN PDF for one supplier's goods on a truck sold from Head Office
 * (`supplier` = its id, or "none"). Head Office only. The first download gives
 * it a GRN number; later downloads keep it. Posts nothing.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; supplier: string }> }) {
  const { id, supplier } = await ctx.params;
  let user;
  try { user = await assertActiveUser(); } catch { return new Response("Not signed in.", { status: 401 }); }
  const notFound = new Response("Not found.", { status: 404 });
  if (!UUID.test(id) || (supplier !== "none" && !UUID.test(supplier))) return notFound;
  if (!userHasPermission(user, "sales.view")) return notFound;

  const admin = createAdminClient();
  const { data: s } = await admin.from("sales_shipments")
    .select("id, company_id, branch_id, document_number, delivery_note_number, dispatched_at, vehicle_registration, trailer_registration, driver_name, driver_phone, driver_licence, status, branch:branches(code, name), order:sales_orders(document_number, customer:customers(code, name, address))")
    .eq("id", id).maybeSingle();
  if (!s || (!user.isOwner && !user.companyIds.includes(s.company_id))) return notFound;
  if (!(await isHeadOfficeUser(user, s.company_id))) return new Response("Only Head Office can issue GRNs.", { status: 403 });

  const supplierId = supplier === "none" ? null : supplier;
  const group = (await salesShipmentGrnGroups(id)).find((g) => g.supplierId === supplierId);
  if (!group) return notFound;

  const { data: num, error } = await admin.rpc("issue_sales_shipment_grn", { p_shipment: id, p_supplier: supplierId, p_user: user.id });
  if (error) return new Response(error.message.replace(/^ERROR:\s*/i, ""), { status: 400 });
  const { data: grn } = await admin.from("sales_shipment_grns").select("created_at").eq("company_id", s.company_id).eq("document_number", num as string).single();

  const [{ data: company }, { data: sup }, { data: lines }] = await Promise.all([
    admin.from("companies").select("name, legal_name, address, phone, email").eq("id", s.company_id).single(),
    supplierId
      ? admin.from("suppliers").select("code, name, contact_person, phone, email, tin, vat_number, address, payment_terms_days").eq("id", supplierId).single()
      : Promise.resolve({ data: null }),
    admin.from("sales_shipment_lines").select("id, qty_dispatched, batch_reference, order_line:sales_order_lines(line_no, product_id, product:products(sku, name, net_weight_kg, unit:units(code)))")
      .in("id", group.lineIds),
  ]);

  type Line = { qty_dispatched: number; batch_reference: string | null;
    order_line: { line_no: number; product_id: string; product: { sku: string; name: string; net_weight_kg: number | null; unit: { code: string } | null } | null } | null };
  const ls = ((lines ?? []) as unknown as Line[]).sort((a, b) => (a.order_line?.line_no ?? 0) - (b.order_line?.line_no ?? 0));
  const kg: Record<string, number | null> = {};
  for (const l of ls) {
    const pid = l.order_line?.product_id;
    if (pid && !(pid in kg)) { const { data } = await admin.rpc("_kg_per_unit", { p_product: pid }); kg[pid] = data === null ? null : Number(data); }
  }
  const order = s.order as unknown as { document_number: string; customer: { code: string; name: string; address: string | null } | null } | null;
  const branch = s.branch as unknown as { code: string; name: string };
  const data: GrnData = {
    number: num as string, issued_at: grn?.created_at ?? new Date().toISOString(),
    company: company!, supplier: sup,
    transfer: { number: s.document_number, date: (s.dispatched_at ?? new Date().toISOString()).slice(0, 10), reference: order?.document_number ?? null, status: s.status },
    from: branch,
    to: { code: order?.customer?.code ?? "", name: order?.customer?.name ?? "", address: order?.customer?.address ?? null },
    delivery_notes: s.delivery_note_number ? [s.delivery_note_number] : [],
    trucks: [{ trip_no: 1, truck: s.vehicle_registration, trailer: s.trailer_registration, driver: s.driver_name, phone: s.driver_phone,
      licence: canUseLicenceNumber(user) ? s.driver_licence : null }],
    lines: ls.map((l) => {
      const k = l.order_line?.product_id ? kg[l.order_line.product_id] : null;
      const sent = Number(l.qty_dispatched);
      return { sku: l.order_line?.product?.sku ?? "", name: l.order_line?.product?.name ?? "", unit: l.order_line?.product?.unit?.code ?? null,
        batch: l.batch_reference, sent, received: sent, net_kg: k ? Math.round(sent * k * 10000) / 10000 : null };
    }),
  };

  await writeAuditLog({ userId: user.id, companyId: s.company_id, action: "sales_shipment.grn_download", resourceType: "sales_shipment", resourceId: id, newValues: { grn: num, supplier_id: supplierId } });
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
