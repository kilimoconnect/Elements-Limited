import { loadSaleDocument, pdfResponse } from "@/lib/sales/document-data";
import { renderSaleInvoice } from "@/lib/sales/documents";
import { truckDocumentRedirect } from "@/lib/sales/truck-redirect";

/** GET the tax invoice of a posted sale as a PDF download. Posts nothing.
 *  A truck's invoice is the truck's commercial invoice, in the truck document format. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const redirect = await truckDocumentRedirect(req, id, "commercial_invoice");
  if (redirect) return redirect;
  const doc = await loadSaleDocument(id, "invoice");
  if (doc instanceof Response) return doc;
  return pdfResponse(renderSaleInvoice(doc), `Invoice-${doc.document_number}.pdf`);
}
