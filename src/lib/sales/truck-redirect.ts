import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/** When a sale is a truck's commercial invoice, send its PDF links to the truck documents
 *  so every copy has the one agreed format. Access is checked by the truck document route. */
export async function truckDocumentRedirect(req: Request, saleId: string, kind: "commercial_invoice" | "delivery_note"): Promise<Response | null> {
  if (!/^[0-9a-f-]{36}$/i.test(saleId)) return null;
  const { data } = await createAdminClient().from("sales").select("shipment_id").eq("id", saleId).maybeSingle();
  const shipmentId = (data as { shipment_id: string | null } | null)?.shipment_id;
  if (!shipmentId) return null;
  const to = new URL(`/api/sales/shipments/${shipmentId}/${kind}`, req.url);
  to.search = new URL(req.url).search;
  return Response.redirect(to, 302);
}
