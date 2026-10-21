import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ReceiveForm, type RecvLine } from "./receive-form";

export const metadata: Metadata = { title: "Receive Import" };
type Params = Promise<{ id: string }>;
const N = (v: unknown) => Number(v ?? 0);

export default async function ReceivePage(props: { params: Params }) {
  await requirePermissionPage("imports.receive");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "imports"))) return <div><PageHeader title="Receive Import" /><EmptyState title="Importation is not enabled" /></div>;
  const { id } = await props.params;
  const admin = createAdminClient();
  const { data: sh } = await admin.from("import_shipments").select("id, company_id, branch_id, document_number, currency_code, logistics_status, ownership_event, ownership_recognised_date").eq("id", id).maybeSingle();
  if (!sh || sh.company_id !== ctx.companyId) notFound();
  const { data: lines } = await admin.from("import_shipment_lines")
    .select("id, line_no, net_kg, shipped_kg, received_kg, short_normal_kg, short_writeoff_kg, short_claim_kg, line_closed, batch_reference, fc_amount, goods_invoiced_fc, product:products(name, stock_role)")
    .eq("shipment_id", id).order("line_no");
  const open: RecvLine[] = ((lines ?? []) as unknown as Array<Record<string, unknown> & { id: string; line_no: number; line_closed: boolean; batch_reference: string | null; product: { name: string; stock_role: string } | null }>)
    .filter((l) => !l.line_closed)
    .map((l) => ({
      id: l.id, label: `${l.line_no}. ${l.product?.name}`, bulk: l.product?.stock_role === "bulk", batch: l.batch_reference,
      transit_kg: Math.max(N(l.shipped_kg ?? l.net_kg) - N(l.received_kg) - N(l.short_normal_kg) - N(l.short_writeoff_kg) - N(l.short_claim_kg), 0),
    }));
  const needsRate = !sh.ownership_recognised_date && sh.ownership_event === "receipt" && sh.currency_code !== "TZS"
    && ((lines ?? []) as unknown as { fc_amount: number; goods_invoiced_fc: number }[]).some((l) => N(l.fc_amount) > N(l.goods_invoiced_fc));
  const branches = ctx.branches.filter((b) => ctx.user.isOwner || ctx.user.branchIds.includes(b.id));
  return (
    <div>
      <PageHeader title={`Receive goods · ${sh.document_number}`} description="Weighbridge net weight into bulk stock at the receiving warehouse." />
      {!["ready", "dispatched", "partially_received"].includes(sh.logistics_status) ? <EmptyState title="This shipment is not open for receiving" /> :
        !sh.ownership_recognised_date && sh.ownership_event !== "receipt" ? <EmptyState title="Record ownership first" description="Ownership of these goods passes before receipt; record it on the shipment page." /> :
        open.length === 0 ? <EmptyState title="Everything has been received" /> : (
          <ReceiveForm shipmentId={id} lines={open} branches={branches.map((b) => ({ id: b.id, label: `${b.code} — ${b.name}` }))}
            defaultBranchId={branches.some((b) => b.id === sh.branch_id) ? sh.branch_id : branches[0]?.id ?? ""} needsRate={needsRate} currency={sh.currency_code} />
        )}
    </div>
  );
}
