import { loadSaleDocument, pdfResponse } from "@/lib/sales/document-data";
import { renderSaleDeliveryNote } from "@/lib/sales/documents";
import { truckDocumentRedirect } from "@/lib/sales/truck-redirect";

/** GET the delivery note of a posted sale as a PDF download. Posts nothing.
 *  A truck's invoice uses the truck's delivery note, in the truck document format. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const redirect = await truckDocumentRedirect(req, id, "delivery_note");
  if (redirect) return redirect;
  const doc = await loadSaleDocument(id, "delivery_note");
  if (doc instanceof Response) return doc;
  return pdfResponse(renderSaleDeliveryNote(doc), `DeliveryNote-${doc.document_number}.pdf`);
}
