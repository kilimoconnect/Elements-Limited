import { assertActiveUser } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { pdfResponse } from "@/lib/sales/document-data";
import { renderTruckDocument, type TruckDocKind, type TruckSnapshot } from "@/lib/sales/truck-documents";

const KINDS: TruckDocKind[] = ["loading_order", "delivery_note", "commercial_invoice"];
const NAME: Record<TruckDocKind, string> = { loading_order: "LoadingOrder", delivery_note: "DeliveryNote", commercial_invoice: "CommercialInvoice" };

/** GET a truck document as PDF from its latest stored version. Reprinting posts nothing. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await ctx.params;
  let user;
  try { user = await assertActiveUser(); } catch { return new Response("Not signed in.", { status: 401 }); }
  const notFound = new Response("Not found.", { status: 404 });
  if (!/^[0-9a-f-]{36}$/i.test(id) || !KINDS.includes(kind as TruckDocKind) || !userHasPermission(user, "sales.view")) return notFound;

  const admin = createAdminClient();
  const { data: s } = await admin.from("sales_shipments").select("company_id, branch_id, document_number").eq("id", id).maybeSingle();
  if (!s || (!user.isOwner && (!user.companyIds.includes(s.company_id) || !user.branchIds.includes(s.branch_id)))) return notFound;
  const { data: v } = await admin.from("document_versions").select("snapshot, version").eq("owner_type", "sales_shipment").eq("owner_id", id).eq("kind", kind)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (!v) return notFound;
  const snap = v.snapshot as TruckSnapshot;
  if (!user.isOwner && !userHasPermission(user, "documents.view_licence")) snap.transport = { ...snap.transport, driver_licence: snap.transport.driver_licence ? "on file" : null };

  await writeAuditLog({ userId: user.id, companyId: s.company_id, branchId: s.branch_id, action: `sales_shipment.${kind}_download`, resourceType: "sales_shipment", resourceId: id });
  const no = kind === "commercial_invoice" ? snap.invoice?.number : kind === "delivery_note" ? snap.shipment.delivery_note_number : snap.shipment.loading_order_number;
  return pdfResponse(renderTruckDocument(snap), `${NAME[kind as TruckDocKind]}-${no ?? s.document_number}.pdf`);
}
