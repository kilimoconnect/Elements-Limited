import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AttachmentsPanel } from "@/components/common/attachments-panel";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";
import { STATUS_VARIANT } from "../status";
import { OrderActions } from "./order-actions";

export const metadata: Metadata = { title: "Rebagging Order" };
type Params = Promise<{ id: string }>;
const N = (v: unknown) => Number(v ?? 0);

export default async function RebagOrderPage(props: { params: Params }) {
  await requirePermissionPage("rebagging.view");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "rebagging"))) return <div><PageHeader title="Rebagging Order" /><EmptyState title="Rebagging is not enabled" /></div>;
  const { id } = await props.params;
  const admin = createAdminClient();
  const { data: o } = await admin.from("rebag_orders")
    .select("*, branch:branches(code, name), bulk:products!rebag_orders_bulk_product_id_fkey(name, sku), shipment:import_shipments(id, document_number)")
    .eq("id", id).maybeSingle();
  if (!o || o.company_id !== ctx.companyId || (!ctx.user.isOwner && !ctx.user.branchIds.includes(o.branch_id))) notFound();
  const [{ data: outputs }, { data: inputs }, { data: charges }, { data: deps }] = await Promise.all([
    admin.from("rebag_outputs").select("id, line_no, bags, net_kg, bulk_value, packaging_value, conversion_value, value_tzs, cost_delta_tzs, product:products(name, net_weight_kg), lot:stock_lots(lot_code)").eq("order_id", id).order("line_no"),
    admin.from("rebag_inputs").select("id, input_kind, quantity, damaged_qty, qty_per_bag, value_tzs, target_output_id, product:products(name), lot:stock_lots(lot_code)").eq("order_id", id).order("line_no"),
    admin.from("cost_sources").select("id, description, status, estimated_amount, accrued_amount, actual_amount, allocation_basis, inventory_treatment, category:cost_categories(name)").eq("rebag_order_id", id).order("created_at"),
    o.document_status === "completed" ? admin.rpc("rebag_order_dependents", { p_id: id }) : Promise.resolve({ data: [] }),
  ]);
  type Out = { id: string; line_no: number; bags: number; net_kg: number; bulk_value: number; packaging_value: number; conversion_value: number; value_tzs: number; cost_delta_tzs: number;
    product: { name: string; net_weight_kg: number } | null; lot: { lot_code: string | null } | null };
  type Inp = { id: string; input_kind: string; quantity: number; damaged_qty: number; qty_per_bag: number | null; value_tzs: number; target_output_id: string | null;
    product: { name: string } | null; lot: { lot_code: string | null } | null };
  const outs = (outputs ?? []) as unknown as Out[];
  const ins = (inputs ?? []) as unknown as Inp[];
  const bulkLines = ins.filter((i) => i.input_kind === "bulk");
  const packLines = ins.filter((i) => i.input_kind === "packaging");
  const issuedKg = N(o.issued_kg) || bulkLines.reduce((a, l) => a + N(l.quantity), 0);
  const packedKg = outs.reduce((a, x) => a + N(x.net_kg), 0);
  const bags = outs.reduce((a, x) => a + N(x.bags), 0);
  const diff = Math.round((issuedKg - packedKg - N(o.returned_kg) - N(o.normal_loss_kg) - N(o.abnormal_loss_kg)) * 1e4) / 1e4;
  const done = ["completed", "voided"].includes(o.document_status);
  const outName = (oid: string | null) => outs.find((x) => x.id === oid)?.product?.name ?? "all sizes (by bags)";
  const showCost = can(ctx.user, "inventory.view_cost") || can(ctx.user, "imports.view_cost");
  return (
    <div className="space-y-4">
      <PageHeader title={`Rebagging ${o.document_number ?? "(draft)"}`}
        description={`${o.bulk?.name} at ${o.branch?.code} — ${o.branch?.name}`}
        actions={<OrderActions id={id} status={o.document_status}
          can={{ edit: can(ctx.user, "rebagging.create"), post: can(ctx.user, "rebagging.post"), void: can(ctx.user, "rebagging.void") }} />} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card><CardContent className="space-y-1 p-5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Status</span><Badge variant={STATUS_VARIANT[o.document_status]}>{o.document_status}</Badge></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Costing</span><span>{o.cost_status}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Order date</span><span>{formatDate(o.order_date)}</span></div>
          {o.issue_date && <div className="flex justify-between"><span className="text-muted-foreground">Issued</span><span>{formatDate(o.issue_date)}</span></div>}
          {o.completion_date && <div className="flex justify-between"><span className="text-muted-foreground">Completed</span><span>{formatDate(o.completion_date)}</span></div>}
          <div className="flex justify-between"><span className="text-muted-foreground">Location / operator</span><span>{o.location ?? "—"} · {o.operator_name ?? "—"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Shipment</span>{o.shipment ? <Link className="font-mono text-xs underline" href={`/imports/${o.shipment.id}`}>{o.shipment.document_number}</Link> : <span>—</span>}</div>
          {o.void_reason && <p className="pt-2 text-xs text-muted-foreground">Reason: {o.void_reason}</p>}
        </CardContent></Card>
        <Card><CardContent className="space-y-1 p-5 text-sm tabular-nums">
          <h3 className="mb-1 font-semibold">Kg balance</h3>
          <div className="flex justify-between"><span>Bulk issued</span><span>{formatQuantity(issuedKg)} kg</span></div>
          <div className="flex justify-between"><span>Good bags ({formatQuantity(bags)})</span><span>{formatQuantity(packedKg)} kg</span></div>
          <div className="flex justify-between"><span>Unused bulk returned</span><span>{formatQuantity(N(o.returned_kg))} kg</span></div>
          <div className="flex justify-between"><span>Normal loss (absorbed)</span><span>{formatQuantity(N(o.normal_loss_kg))} kg</span></div>
          <div className="flex justify-between"><span>Abnormal loss (expensed)</span><span>{formatQuantity(N(o.abnormal_loss_kg))} kg</span></div>
          <div className={`flex justify-between font-semibold ${diff === 0 ? "text-success" : "text-destructive"}`}><span>Unexplained</span><span>{formatQuantity(diff)} kg</span></div>
        </CardContent></Card>
        {showCost && <Card><CardContent className="space-y-1 p-5 text-sm tabular-nums">
          <h3 className="mb-1 font-semibold">Value (TZS)</h3>
          <div className="flex justify-between"><span>Bulk issued</span><span>{formatMoney(N(o.issued_value))}</span></div>
          <div className="flex justify-between"><span>Bulk returned</span><span>{formatMoney(N(o.returned_value))}</span></div>
          <div className="flex justify-between"><span>Abnormal loss to expense</span><span>{formatMoney(N(o.abnormal_loss_value))}</span></div>
          <div className="flex justify-between"><span>Packaging</span><span>{formatMoney(N(o.packaging_value))}</span></div>
          <div className="flex justify-between"><span>Conversion (capitalised)</span><span>{formatMoney(N(o.conversion_value))}</span></div>
          <div className="flex justify-between font-semibold"><span>Packaged output</span><span>{formatMoney(N(o.output_value))}</span></div>
        </CardContent></Card>}
      </div>

      <Card><CardContent className="p-0">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Output</TableHead><TableHead className="text-right">Good bags</TableHead><TableHead className="text-right">Net kg</TableHead>
            {showCost && <><TableHead className="text-right">Bulk</TableHead><TableHead className="text-right">Packaging</TableHead><TableHead className="text-right">Conversion</TableHead>
            <TableHead className="text-right">Total</TableHead><TableHead className="text-right">Per bag</TableHead><TableHead className="text-right">Later adj.</TableHead></>}
            <TableHead>Lot</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {outs.map((x) => (
              <TableRow key={x.id}>
                <TableCell>{x.product?.name} <span className="text-xs text-muted-foreground">({N(x.product?.net_weight_kg)} kg)</span></TableCell>
                <TableCell className="text-right tabular-nums">{formatQuantity(N(x.bags))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatQuantity(N(x.net_kg))}</TableCell>
                {showCost && <>
                  <TableCell className="text-right tabular-nums">{done ? formatMoney(N(x.bulk_value)) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{done ? formatMoney(N(x.packaging_value)) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{done ? formatMoney(N(x.conversion_value)) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{done ? formatMoney(N(x.value_tzs)) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{done ? formatMoney(N(x.value_tzs) / N(x.bags)) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{N(x.cost_delta_tzs) ? formatMoney(N(x.cost_delta_tzs)) : "—"}</TableCell>
                </>}
                <TableCell className="font-mono text-xs">{x.lot?.lot_code ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent></Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card><CardContent className="p-5 text-sm">
          <h3 className="mb-2 font-semibold">Bulk batches</h3>
          {bulkLines.map((l) => (
            <div key={l.id} className="flex justify-between border-b border-border py-1 last:border-0">
              <span className="font-mono text-xs">{l.lot?.lot_code ?? "untracked"}</span><span className="tabular-nums">{formatQuantity(N(l.quantity))} kg</span>
            </div>
          ))}
          <h3 className="mb-2 mt-4 font-semibold">Packaging used</h3>
          {packLines.length === 0 ? <p className="text-muted-foreground">None recorded.</p> : packLines.map((l) => (
            <div key={l.id} className="flex justify-between border-b border-border py-1 last:border-0">
              <span>{l.product?.name} <span className="text-xs text-muted-foreground">→ {outName(l.target_output_id)}{l.qty_per_bag ? ` · ${N(l.qty_per_bag)}/bag` : ""}</span></span>
              <span className="tabular-nums">{formatQuantity(N(l.quantity))}{N(l.damaged_qty) ? ` (${formatQuantity(N(l.damaged_qty))} damaged)` : ""}{showCost && done ? ` · ${formatMoney(N(l.value_tzs))}` : ""}</span>
            </div>
          ))}
        </CardContent></Card>
        <Card><CardContent className="p-5 text-sm">
          <h3 className="mb-2 font-semibold">Conversion charges</h3>
          {((charges ?? []) as unknown as { id: string; description: string | null; status: string; estimated_amount: number; accrued_amount: number; actual_amount: number;
            allocation_basis: string | null; inventory_treatment: string; category: { name: string } | null }[]).map((c) => (
            <div key={c.id} className="flex justify-between border-b border-border py-1 last:border-0">
              <span>{c.category?.name}{c.description ? ` — ${c.description}` : ""} <span className="text-xs text-muted-foreground">
                ({c.inventory_treatment === "capitalize" ? `capitalised ${c.allocation_basis === "quantity" ? "by bags" : c.allocation_basis === "weight" ? "by kg" : `by ${c.allocation_basis}`}` : "expensed"} · {c.status})</span></span>
              <span className="tabular-nums">{formatMoney(N(c.status === "invoiced" ? c.actual_amount : c.status === "accrued" ? c.accrued_amount : c.estimated_amount))}</span>
            </div>
          ))}
          {(charges ?? []).length === 0 && <p className="text-muted-foreground">None.</p>}
          {o.document_status === "completed" && (charges ?? []).some((c) => c.status === "accrued") && can(ctx.user, "cost_invoices.post") &&
            <p className="mt-2 text-xs"><Link className="underline" href="/imports/cost-invoices/new">Post the contractor&apos;s invoice</Link> against the accrued charge.</p>}
          {((deps ?? []) as { source_type: string; source_number: string; quantity: number }[]).length > 0 && (
            <div className="mt-4 rounded-md bg-warning/10 p-3 text-xs">
              <p className="font-medium">Bags already used (void blocked until reversed):</p>
              {((deps ?? []) as { source_type: string; source_number: string; quantity: number }[]).map((x, i) => <p key={i}>{x.source_type} {x.source_number} — {formatQuantity(N(x.quantity))}</p>)}
            </div>
          )}
        </CardContent></Card>
      </div>

      <Card><CardContent className="p-5">
        <h3 className="mb-2 font-semibold">Attachments</h3>
        <AttachmentsPanel ownerType="rebag_order" ownerId={id} categories={["photo", "delivery_note", "other"]} />
      </CardContent></Card>
    </div>
  );
}
