import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { loadRequest } from "@/lib/sales/fulfilment-data";
import { loadRequestFormData } from "@/lib/sales/request-form-data";
import { RequestForm } from "../../../new/request-form";

export const metadata: Metadata = { title: "Edit Sales Request" };

export default async function EditSalesRequestPage(props: { params: Promise<{ id: string }> }) {
  await requirePermissionPage("sales.edit_draft");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();
  const { rq, lines, payments, funds } = await loadRequest(admin, ctx.user, ctx.companyId, id);
  if (!["draft", "returned"].includes(rq.status)) redirect(`/sales/requests/${id}`);
  const d = await loadRequestFormData(ctx.companyId, rq.branch_id);
  const { count } = await admin.from("document_attachments").select("id", { count: "exact", head: true })
    .eq("owner_type", "sales_request").eq("owner_id", id).eq("category", "proof_of_payment");
  // Funds this request already holds are shown as available again while editing.
  const own = new Map(funds.map((f) => [f.receipt_id as string, Number(f.amount)]));
  const fundOpts = d.funds.map((f) => (own.has(f.id) ? { ...f, available: f.available } : f));

  return (
    <div>
      <PageHeader title={`Edit Sales Request ${rq.document_number ?? ""}`} description={rq.decision_reason ? `Returned: ${rq.decision_reason}` : undefined} />
      <RequestForm branchId={rq.branch_id} products={d.products} taxCodes={d.taxCodes as never} accounts={d.accounts as never}
        customers={d.customers as never} onHand={d.onHand} reserved={d.reserved} funds={fundOpts}
        promotions={d.promotions} rewards={d.rewards}
        initial={{
          requestId: id, customerId: rq.customer_id, contactName: rq.contact_name ?? "", contactPhone: rq.contact_phone ?? "",
          mode: rq.fulfilment_mode, location: rq.fulfilment_location ?? "", destination: rq.destination ?? "",
          consigneeName: rq.consignee_name ?? "", consigneePhone: rq.consignee_phone ?? "", notes: rq.notes ?? "", orderDiscount: 0,
          lines: lines.filter((l) => !l.is_free).map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit_price: Number(l.unit_price),
            discount: Number(l.discount), tax_code_id: l.tax_code_id })),
          payments: payments.map((p) => ({ payment_method: p.payment_method, payment_account_id: p.payment_account_id, payment_date: p.payment_date,
            amount: Number(p.amount), reference: p.reference })),
          funds: funds.map((f) => ({ receipt_id: f.receipt_id, amount: Number(f.amount) })),
          hasProof: (count ?? 0) > 0,
        }} />
    </div>
  );
}
