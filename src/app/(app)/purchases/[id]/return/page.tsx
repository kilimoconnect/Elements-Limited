import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { PurchaseReturnForm, type RLine } from "./return-form";

export const metadata: Metadata = { title: "Purchase Return" };
type Params = Promise<{ id: string }>;

export default async function PurchaseReturnPage(props: { params: Params }) {
  await requirePermissionPage("purchases.create_return");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();

  const { data: pur } = await admin.from("purchases").select("id, company_id, branch_id, document_number, document_status, currency_code").eq("id", id).maybeSingle();
  if (!pur || pur.company_id !== ctx.companyId || pur.document_status !== "posted") notFound();

  const { data: lines } = await admin.from("purchase_lines").select("id, description, quantity, unit_cost, gross_amount, fc_gross_amount").eq("purchase_id", id).order("line_no");
  const { data: prior } = await admin.from("purchase_return_lines")
    .select("purchase_line_id, quantity, purchase_return:purchase_returns!inner(document_status)")
    .in("purchase_line_id", (lines ?? []).map((l) => l.id));
  const returnedMap = new Map<string, number>();
  for (const p of prior ?? []) {
    const pr = p as unknown as { purchase_line_id: string; quantity: number; purchase_return: { document_status: string } | null };
    if (pr.purchase_return?.document_status !== "posted") continue;
    returnedMap.set(pr.purchase_line_id, (returnedMap.get(pr.purchase_line_id) ?? 0) + Number(pr.quantity));
  }
  const rLines: RLine[] = (lines ?? []).map((l) => ({
    purchase_line_id: l.id, description: l.description ?? "", bought: Number(l.quantity),
    returned: returnedMap.get(l.id) ?? 0, unit_cost: Number(l.unit_cost), line_total: Number(l.gross_amount),
    fc_line_total: l.fc_gross_amount == null ? null : Number(l.fc_gross_amount),
  }));

  const { data: accounts } = await admin.from("payment_accounts").select("id, name, branch_id").eq("company_id", ctx.companyId).eq("is_active", true).order("code");
  const branchAccounts = (accounts ?? []).filter((a) => !a.branch_id || a.branch_id === pur.branch_id);

  return (
    <div>
      <PageHeader title="Purchase Return" description={`Against purchase ${pur.document_number}`} />
      <PurchaseReturnForm purchaseId={id} lines={rLines} accounts={branchAccounts as never} currency={pur.currency_code} />
    </div>
  );
}
