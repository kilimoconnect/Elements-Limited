import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { assertActiveUser } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import type { SaleDocData } from "./documents";

/**
 * Loads a posted sale for its invoice / delivery note PDF, or a Response to
 * return instead (not signed in, not found, no access). Users need
 * sales.view and access to the sale's branch.
 */
export async function loadSaleDocument(saleId: string, kind: "invoice" | "delivery_note"): Promise<SaleDocData | Response> {
  let user;
  try { user = await assertActiveUser(); } catch { return new Response("Not signed in.", { status: 401 }); }
  const notFound = new Response("Not found.", { status: 404 });
  if (!/^[0-9a-f-]{36}$/i.test(saleId)) return notFound;
  if (!userHasPermission(user, "sales.view")) return notFound;

  const admin = createAdminClient();
  const { data: sale } = await admin.from("sales")
    .select("*, customer:customers(code,name,phone,address,tin,vat_number), branch:branches(name,address,phone)")
    .eq("id", saleId).maybeSingle();
  if (!sale || sale.document_status !== "posted") return notFound;
  if (!user.isOwner && (!user.companyIds.includes(sale.company_id) || !user.branchIds.includes(sale.branch_id))) return notFound;

  const [{ data: company }, { data: lines }, { data: payments }, { data: approver }] = await Promise.all([
    admin.from("companies").select("name, legal_name, address, phone, email").eq("id", sale.company_id).single(),
    admin.from("sale_lines").select("description, quantity, unit_price, discount, tax_name, line_total, product:products(sku, unit:units(symbol, code))").eq("sale_id", saleId).order("line_no"),
    admin.from("sale_payments").select("amount, account:payment_accounts(name)").eq("sale_id", saleId),
    sale.approved_by
      ? admin.from("user_profiles").select("full_name, email").eq("id", sale.approved_by).maybeSingle()
      : Promise.resolve({ data: null as { full_name: string | null; email: string } | null }),
  ]);

  await writeAuditLog({
    userId: user.id, companyId: sale.company_id, branchId: sale.branch_id,
    action: kind === "invoice" ? "sale.invoice_download" : "sale.delivery_note_download", resourceType: "sale", resourceId: saleId,
  });

  type Line = { description: string; quantity: number; unit_price: number; discount: number; tax_name: string | null; line_total: number; product: { sku: string; unit: { symbol: string | null; code: string } | null } | null };
  return {
    company: company!,
    branch: sale.branch,
    customer: sale.customer,
    document_number: sale.document_number, document_date: sale.document_date, due_date: sale.due_date,
    customer_reference: sale.customer_reference,
    lines: ((lines ?? []) as unknown as Line[]).map((l) => ({
      sku: l.product?.sku ?? "", description: l.description, unit: l.product?.unit?.symbol || l.product?.unit?.code || null,
      quantity: Number(l.quantity), unit_price: Number(l.unit_price), discount: Number(l.discount),
      tax_name: l.tax_name, line_total: Number(l.line_total),
    })),
    subtotal: Number(sale.subtotal), discount_total: Number(sale.discount_total), net_total: Number(sale.net_total),
    tax_total: Number(sale.tax_total), grand_total: Number(sale.grand_total),
    amount_paid: Number(sale.amount_paid), outstanding: Number(sale.outstanding),
    payments: ((payments ?? []) as unknown as { amount: number; account: { name: string } | null }[])
      .map((p) => ({ account: p.account?.name ?? "", amount: Number(p.amount) })),
    approved_by: approver ? (approver.full_name || approver.email) : null,
    approved_at: sale.approved_at,
  };
}

export function pdfResponse(bytes: Uint8Array, fileName: string): Response {
  const name = fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(new Blob([bytes as BlobPart], { type: "application/pdf" }), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
