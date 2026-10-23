import { loadSaleDocument, pdfResponse } from "@/lib/sales/document-data";
import { renderSaleInvoice } from "@/lib/sales/documents";

/** GET the tax invoice of a posted sale as a PDF download. Posts nothing. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const doc = await loadSaleDocument(id, "invoice");
  if (doc instanceof Response) return doc;
  return pdfResponse(renderSaleInvoice(doc), `Invoice-${doc.document_number}.pdf`);
}
