import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { AttachmentsPanel } from "@/components/common/attachments-panel";
import { Card, CardContent } from "@/components/ui/card";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { formatMoney, formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "Supplier Payment" };
type Params = Promise<{ id: string }>;

export default async function SupplierPaymentDetail(props: { params: Params }) {
  await requirePermissionPage("purchases.record_payment");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();

  const { data: pay } = await admin.from("supplier_payments").select("*, supplier:suppliers(name), branch:branches(name)").eq("id", id).maybeSingle();
  if (!pay || pay.company_id !== ctx.companyId) notFound();
  const [{ data: funding }, { data: allocs }] = await Promise.all([
    admin.from("supplier_payment_funding").select("amount, reference, account:payment_accounts(name)").eq("payment_id", id),
    admin.from("supplier_payment_allocations").select("amount, payable:supplier_payables(purchase:purchases(document_number), expense:expenses(document_number))").eq("payment_id", id),
  ]);
  const p = pay as Record<string, unknown> as { document_number: string | null; document_status: string; document_date: string; amount: number; reference: string | null; void_reason: string | null; supplier: { name: string } | null; branch: { name: string } | null };

  return (
    <div className="space-y-4">
      <Button asChild variant="outline" size="sm"><Link href="/purchases/supplier-payments"><ArrowLeft className="h-4 w-4" /> Back to supplier payments</Link></Button>
      <PageHeader title={p.document_number ?? "Supplier payment"} description={`${p.supplier?.name} · ${formatDate(p.document_date)}`} />
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card><CardContent className="space-y-2 p-5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Status</span><DocStatusBadge status={p.document_status} /></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="tabular-nums font-semibold">{formatMoney(p.amount)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Reference</span><span>{p.reference ?? "—"}</span></div>
          {p.void_reason && <div className="flex justify-between"><span className="text-muted-foreground">Void reason</span><span>{p.void_reason}</span></div>}
        </CardContent></Card>
        <Card><CardContent className="p-5"><h3 className="mb-2 text-sm font-semibold">Funded from</h3>
          <div className="space-y-1 text-sm">{(funding ?? []).map((f, i) => { const ff = f as unknown as { account: { name: string } | null; amount: number }; return <div key={i} className="flex justify-between"><span className="text-muted-foreground">{ff.account?.name}</span><span className="tabular-nums">{formatMoney(ff.amount)}</span></div>; })}</div>
        </CardContent></Card>
        <Card><CardContent className="p-5"><h3 className="mb-2 text-sm font-semibold">Applied to</h3>
          <div className="space-y-1 text-sm">{(allocs ?? []).map((a, i) => { const aa = a as unknown as { amount: number; payable: { purchase: { document_number: string } | null; expense: { document_number: string } | null } | null }; const num = aa.payable?.purchase?.document_number ?? aa.payable?.expense?.document_number ?? "—"; return <div key={i} className="flex justify-between"><span className="text-muted-foreground">{num}</span><span className="tabular-nums">{formatMoney(aa.amount)}</span></div>; })}</div>
        </CardContent></Card>
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Proof of payment</p>
        <AttachmentsPanel ownerType="supplier_payment" ownerId={id} categories={["proof_of_payment", "other"]} />
      </div>
    </div>
  );
}
