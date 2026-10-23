import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { flattenProducts } from "@/lib/products";
import { PageHeader } from "@/components/ui/page-header";
import { SaleForm } from "../../new/sale-form";

export const metadata: Metadata = { title: "Edit Sales Order" };
type Params = Promise<{ id: string }>;

/** Edits a draft sales order that is not awaiting approval (e.g. one that was rejected). */
export default async function EditSalePage(props: { params: Params }) {
  await requirePermissionPage("sales.edit_draft");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();

  const { data: sale } = await admin.from("sales").select("*").eq("id", id).maybeSingle();
  if (!sale || sale.company_id !== ctx.companyId) notFound();
  if (!ctx.user.isOwner && !ctx.user.branchIds.includes(sale.branch_id)) notFound();
  if (sale.document_status !== "draft" || sale.approval_status === "pending") redirect(`/sales/${id}`);

  const [{ data: products }, { data: taxCodes }, { data: accounts }, { data: customers }, { data: bals }, { data: lines }, { data: payments }, { count: proofs }] = await Promise.all([
    admin.from("products").select("id, sku, barcode, name, selling_price, tax_code_id, track_inventory, category:product_categories(name), brand:brands(name)").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("tax_codes").select("id, name, rate, is_inclusive").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("payment_accounts").select("id, code, name, branch_id").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("customers").select("id, code, name, is_protected").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("stock_balances").select("product_id, quantity").eq("company_id", ctx.companyId).eq("branch_id", sale.branch_id),
    admin.from("sale_lines").select("product_id, quantity, unit_price, discount, tax_code_id").eq("sale_id", id).order("line_no"),
    admin.from("sale_payments").select("payment_account_id, amount").eq("sale_id", id),
    admin.from("document_attachments").select("id", { count: "exact", head: true }).eq("owner_type", "sale").eq("owner_id", id).eq("category", "proof_of_payment"),
  ]);

  const stock: Record<string, number> = {};
  for (const b of bals ?? []) stock[b.product_id] = Number(b.quantity);
  const branchAccounts = (accounts ?? []).filter((a) => !a.branch_id || a.branch_id === sale.branch_id);
  const walkIn = (customers ?? []).find((c) => c.is_protected);

  return (
    <div>
      <PageHeader
        title="Edit Sales Order"
        description={sale.approval_status === "rejected" && sale.rejection_reason
          ? `Rejected: ${sale.rejection_reason}. Correct the order and submit it again.`
          : "Change the order, then save it or submit it for approval."}
      />
      <SaleForm
        branchId={sale.branch_id}
        products={flattenProducts(products)}
        taxCodes={(taxCodes ?? []).map((t) => ({ ...t, rate: Number(t.rate) })) as never}
        accounts={branchAccounts as never}
        customers={(customers ?? []) as never}
        stock={stock}
        canViewCost={can(ctx.user, "sales.view_cost")}
        walkInId={walkIn?.id ?? null}
        canApprove={can(ctx.user, "sales.approve")}
        initial={{
          saleId: id,
          customerId: sale.customer_id,
          date: sale.document_date,
          dueDate: sale.due_date ?? "",
          reference: sale.customer_reference ?? "",
          notes: sale.notes ?? "",
          lines: (lines ?? []).map((l) => ({
            product_id: l.product_id, quantity: Number(l.quantity), unit_price: Number(l.unit_price),
            discount: Number(l.discount), tax_code_id: l.tax_code_id,
          })),
          payments: (payments ?? []).map((p) => ({ payment_account_id: p.payment_account_id, amount: Number(p.amount) })),
          hasProof: (proofs ?? 0) > 0,
        }}
      />
    </div>
  );
}
