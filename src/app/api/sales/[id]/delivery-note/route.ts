import { loadSaleDocument, pdfResponse } from "@/lib/sales/document-data";
import { renderSaleDeliveryNote } from "@/lib/sales/documents";

/** GET the delivery note of a posted sale as a PDF download. Posts nothing. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const doc = await loadSaleDocument(id, "delivery_note");
  if (doc instanceof Response) return doc;
  return pdfResponse(renderSaleDeliveryNote(doc), `DeliveryNote-${doc.document_number}.pdf`);
}
