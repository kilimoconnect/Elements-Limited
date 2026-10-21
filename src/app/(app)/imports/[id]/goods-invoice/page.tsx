import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { GoodsInvoiceForm, type InvLine } from "./invoice-form";

export const metadata: Metadata = { title: "Import Goods Invoice" };
type Params = Promise<{ id: string }>;

export default async function GoodsInvoicePage(props: { params: Params }) {
  await requirePermissionPage("imports.post");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "imports"))) return <div><PageHeader title="Import Goods Invoice" /><EmptyState title="Importation is not enabled" /></div>;
  const { id } = await props.params;
  const admin = createAdminClient();
  const { data: sh } = await admin.from("import_shipments").select("id, company_id, document_number, currency_code").eq("id", id).maybeSingle();
  if (!sh || sh.company_id !== ctx.companyId) notFound();
  const [{ data: lines }, { data: taxCodes }, { data: rates }] = await Promise.all([
    admin.from("import_shipment_lines").select("id, line_no, quantity, fc_amount, goods_invoiced_qty, product:products(name, stock_role)").eq("shipment_id", id).order("line_no"),
    admin.from("tax_codes").select("id, name, rate").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    sh.currency_code === "TZS" ? Promise.resolve({ data: [] }) : admin.from("exchange_rates").select("rate_date, rate").eq("company_id", ctx.companyId).eq("currency_code", sh.currency_code).order("rate_date", { ascending: false }).limit(500),
  ]);
  const open: InvLine[] = ((lines ?? []) as unknown as Array<{ id: string; line_no: number; quantity: number; fc_amount: number; goods_invoiced_qty: number; product: { name: string; stock_role: string } | null }>)
    .map((l) => ({
      id: l.id, label: `${l.line_no}. ${l.product?.name}`, open_qty: Math.max(Number(l.quantity) - Number(l.goods_invoiced_qty), 0),
      unit_price: Number(l.quantity) > 0 ? Math.round((Number(l.fc_amount) / Number(l.quantity)) * 1e6) / 1e6 : 0,
      unit: l.product?.stock_role === "bulk" ? "kg" : "units",
    })).filter((l) => l.open_qty > 0);
  return (
    <div>
      <PageHeader title={`Goods invoice · ${sh.document_number}`} description={`Supplier invoice for the goods, in ${sh.currency_code}. It creates the supplier balance; stock comes only from goods receipts.`} />
      {open.length === 0 ? <EmptyState title="All shipment lines are fully invoiced" /> : (
        <GoodsInvoiceForm shipmentId={id} currency={sh.currency_code} lines={open}
          taxCodes={(taxCodes ?? []).map((t) => ({ id: t.id, name: t.name, rate: Number(t.rate) }))}
          tableRates={((rates ?? []) as { rate_date: string; rate: number }[]).map((r) => ({ date: r.rate_date, rate: Number(r.rate) }))} />
      )}
    </div>
  );
}
