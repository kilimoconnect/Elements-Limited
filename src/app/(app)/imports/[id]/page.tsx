import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { LOGISTICS_LABEL, COST_LABEL } from "@/lib/imports/queries";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AttachmentsPanel } from "@/components/common/attachments-panel";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";
import { StatusActions, OwnershipAction, AddCostForm, CostRowActions, FinalizeButton, type CategoryOpt } from "./shipment-actions";

export const metadata: Metadata = { title: "Import Shipment" };
type Params = Promise<{ id: string }>;
const N = (v: unknown) => Number(v ?? 0);
const mt = (kg: number) => formatQuantity(kg / 1000);

export default async function ShipmentPage(props: { params: Params }) {
  await requirePermissionPage("imports.view");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "imports"))) return <div><PageHeader title="Import Shipment" /><EmptyState title="Importation is not enabled" /></div>;
  const { id } = await props.params;
  const admin = createAdminClient();
  const { data: sh } = await admin.from("import_shipments").select("*, supplier:suppliers(name), branch:branches(name, code)").eq("id", id).maybeSingle();
  if (!sh || sh.company_id !== ctx.companyId) notFound();
  if (!ctx.user.isOwner && !ctx.user.branchIds.includes(sh.branch_id)) notFound();
  const showCost = can(ctx.user, "imports.view_cost");
  const attachmentsOn = await isFeatureEnabled(ctx.companyId, "attachments");

  const [{ data: lines }, { data: sheet }, { data: checks }, { data: sources }, { data: invoices }, { data: receipts }, { data: categories }, { data: suppliers }] = await Promise.all([
    admin.from("import_shipment_lines").select("*, product:products(name, sku)").eq("shipment_id", id).order("line_no"),
    admin.rpc("landed_cost_sheet", { p_shipment: id }),
    admin.rpc("import_finalization_checks", { p_shipment: id }),
    admin.from("cost_sources").select("*, category:cost_categories(code, name), supplier:suppliers(name), actual:cost_source_actuals(line:cost_invoice_lines(invoice:cost_invoices(id, document_number, supplier_invoice_number)))").eq("import_shipment_id", id).order("created_at"),
    admin.from("purchases").select("id, document_number, supplier_invoice_number, document_date, document_status, currency_code, exchange_rate, fc_grand_total, grand_total").eq("import_shipment_id", id).order("document_date"),
    admin.from("import_receipts").select("id, document_number, receipt_date, document_status, branch:branches(code), lines:import_receipt_lines(net_kg_received, weighbridge_ref, batch_code, is_final, shortage_kg, resolution, value_tzs, cost_delta_tzs, short_value_tzs, shipment_line_id)").eq("shipment_id", id).order("receipt_date"),
    admin.from("cost_categories").select("id, code, name, inventory_treatment, allocation_basis, component").eq("company_id", ctx.companyId).eq("is_active", true).eq("applies_to_import", true).eq("is_goods_value", false).order("name"),
    admin.from("suppliers").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
  ]);
  const receiptIds = (receipts ?? []).map((r) => r.id);
  const sourceIds = (sources ?? []).map((s) => s.id);
  const invoiceIds = (invoices ?? []).map((i) => i.id);
  const costInvoiceIds = (sources ?? []).flatMap((s) => ((s as unknown as { actual: { line: { invoice: { id: string } | null } | null }[] }).actual ?? []).map((a) => a.line?.invoice?.id)).filter(Boolean) as string[];
  const [{ data: movements }, { data: journals }] = await Promise.all([
    receiptIds.length ? admin.from("stock_movements").select("source_number, qty_in, movement_value, created_at, branch:branches(code), product:products(name)").eq("source_type", "import_receipt").in("source_id", receiptIds).order("created_at") : Promise.resolve({ data: [] }),
    admin.from("journal_entries").select("id, entry_date, source_type, source_number, memo").eq("company_id", ctx.companyId)
      .in("source_id", [id, ...receiptIds, ...sourceIds, ...invoiceIds, ...costInvoiceIds]).order("entry_date").limit(200),
  ]);

  const s = sh as Record<string, unknown> & { id: string; document_number: string; logistics_status: string; cost_status: string; currency_code: string;
    ownership_event: string; ownership_recognised_date: string | null; planning_rate: number | null; goods_includes_freight: boolean; goods_includes_insurance: boolean };
  type L = { id: string; line_no: number; quantity: number; net_kg: number; shipped_kg: number | null; batch_reference: string | null; fc_amount: number;
    goods_invoiced_qty: number; received_kg: number; short_normal_kg: number; short_writeoff_kg: number; short_claim_kg: number; line_closed: boolean;
    goods_recognised_tzs: number; costs_applied_tzs: number; git_value: number; product: { name: string; sku: string } | null };
  const ll = (lines ?? []) as unknown as L[];
  const expected = (l: L) => N(l.shipped_kg ?? l.net_kg);
  const transit = (l: L) => l.line_closed ? 0 : Math.max(expected(l) - N(l.received_kg) - N(l.short_normal_kg) - N(l.short_writeoff_kg) - N(l.short_claim_kg), 0);
  const checkRows = (checks ?? []) as { check_key: string; ok: boolean; detail: string }[];
  const closed = ["closed", "cancelled"].includes(s.logistics_status);
  const canReceive = can(ctx.user, "imports.receive") && ["ready", "dispatched", "partially_received"].includes(s.logistics_status);
  const canInvoice = can(ctx.user, "imports.post") && !closed && ll.some((l) => N(l.goods_invoiced_qty) + 0.0001 < N(l.quantity));

  return (
    <div className="space-y-4">
      <PageHeader title={`Import ${s.document_number}`}
        description={`${(sh.supplier as { name: string } | null)?.name} · ${s.incoterm} ${s.named_place ?? ""} · to ${(sh.branch as { name: string } | null)?.name}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {canInvoice && <Button asChild variant="outline"><Link href={`/imports/${id}/goods-invoice`}>Goods invoice</Link></Button>}
            {canReceive && <Button asChild variant="outline"><Link href={`/imports/${id}/receive`}>Receive goods</Link></Button>}
            {can(ctx.user, "cost_invoices.create") && s.logistics_status !== "cancelled" && <Button asChild variant="outline"><Link href={`/imports/cost-invoices/new?shipment=${id}`}>Cost invoice</Link></Button>}
          </div>
        } />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card><CardContent className="space-y-1 p-5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Logistics</span><Badge variant="secondary">{LOGISTICS_LABEL[s.logistics_status]}</Badge></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Costing</span><Badge variant={s.cost_status === "finalized" ? "success" : "secondary"}>{COST_LABEL[s.cost_status]}</Badge></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Bill of lading</span><span className="font-mono text-xs">{(s.bill_of_lading as string) ?? "—"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Vessel / containers</span><span>{(s.vessel as string) ?? "—"} {s.container_refs ? `· ${s.container_refs}` : ""}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Origin</span><span>{[s.origin_country, s.origin_port].filter(Boolean).join(", ") || "—"} → {(s.discharge_port as string) ?? "—"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Shipped / ETA / arrived</span><span>{s.shipped_date ? formatDate(s.shipped_date as string) : "—"} / {s.eta ? formatDate(s.eta as string) : "—"} / {s.arrival_date ? formatDate(s.arrival_date as string) : "—"}</span></div>
        </CardContent></Card>
        <Card><CardContent className="space-y-1 p-5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Currency</span><span>{s.currency_code}{s.planning_rate ? ` · planning ${s.planning_rate}` : ""}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Price includes</span><span>{[s.goods_includes_freight && "freight", s.goods_includes_insurance && "insurance"].filter(Boolean).join(" + ") || "neither freight nor insurance"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Ownership passes at</span><span>{s.ownership_event === "bill_of_lading" ? "bill of lading" : s.ownership_event}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Ownership recorded</span><span>{s.ownership_recognised_date ? formatDate(s.ownership_recognised_date) : "not yet"}</span></div>
        </CardContent></Card>
        <Card><CardContent className="space-y-3 p-5 text-sm">
          <StatusActions id={id} status={s.logistics_status} canEdit={can(ctx.user, "imports.edit_draft")} />
          {!s.ownership_recognised_date && s.ownership_event !== "receipt" && ["ready", "dispatched"].includes(s.logistics_status) && can(ctx.user, "imports.post") &&
            <OwnershipAction id={id} currency={s.currency_code} event={s.ownership_event} planningRate={s.planning_rate ? Number(s.planning_rate) : null} />}
          {s.ownership_event === "receipt" && !s.ownership_recognised_date && <p className="text-xs text-muted-foreground">Ownership will be recorded automatically with the first goods receipt.</p>}
        </CardContent></Card>
      </div>

      <Card><CardContent className="p-0">
        <h3 className="px-5 pt-4 text-sm font-semibold">Quantities (MT)</h3>
        <Table>
          <TableHeader><TableRow>
            <TableHead>Product</TableHead><TableHead>Batch</TableHead><TableHead className="text-right">Ordered</TableHead><TableHead className="text-right">Shipped</TableHead>
            <TableHead className="text-right">Invoiced</TableHead><TableHead className="text-right">Received (saleable)</TableHead><TableHead className="text-right">Shortfall</TableHead>
            <TableHead className="text-right">In transit</TableHead><TableHead className="text-right">Owned in transit</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {ll.map((l) => (
              <TableRow key={l.id}>
                <TableCell>{l.product?.name}<span className="text-xs text-muted-foreground"> {l.product?.sku}</span></TableCell>
                <TableCell className="text-xs">{l.batch_reference ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{mt(N(l.net_kg))}</TableCell>
                <TableCell className="text-right tabular-nums">{mt(expected(l))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatQuantity(N(l.goods_invoiced_qty))} / {formatQuantity(N(l.quantity))}</TableCell>
                <TableCell className="text-right tabular-nums">{mt(N(l.received_kg))}</TableCell>
                <TableCell className="text-right tabular-nums">{mt(N(l.short_normal_kg) + N(l.short_writeoff_kg) + N(l.short_claim_kg))}</TableCell>
                <TableCell className="text-right tabular-nums">{mt(transit(l))}</TableCell>
                <TableCell className="text-right tabular-nums">{s.ownership_recognised_date ? mt(transit(l)) : "0"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent></Card>

      {showCost && (
        <Card><CardContent className="p-0">
          <h3 className="px-5 pt-4 text-sm font-semibold">Landed cost sheet (TZS)</h3>
          <p className="px-5 text-xs text-muted-foreground">Estimate = planning (never posted). Actual = accounting cost of goods plus capitalised costs. Commercial adds expensed costs flagged for pricing (e.g. storage) and does not change stock value.</p>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Product</TableHead><TableHead className="text-right">Est. total</TableHead><TableHead className="text-right">Est. /kg</TableHead>
              <TableHead className="text-right">Goods</TableHead><TableHead className="text-right">Capitalised costs</TableHead><TableHead className="text-right">Actual total</TableHead>
              <TableHead className="text-right">Actual /kg</TableHead><TableHead className="text-right">Commercial /kg</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {((sheet ?? []) as Record<string, unknown>[]).map((r) => (
                <TableRow key={r.line_id as string}>
                  <TableCell>{r.product_name as string}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(N(r.est_total))}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.est_per_kg == null ? "—" : formatMoney(N(r.est_per_kg))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(N(r.act_goods))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(N(r.act_costs))}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatMoney(N(r.act_total))}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{r.act_per_kg == null ? "—" : formatMoney(N(r.act_per_kg))}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.commercial_per_kg == null ? "—" : formatMoney(N(r.commercial_per_kg))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}

      {showCost && (
        <Card><CardContent className="space-y-3 p-0">
          <h3 className="px-5 pt-4 text-sm font-semibold">Costs</h3>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Cost</TableHead><TableHead>Treatment</TableHead><TableHead>Allocate by</TableHead><TableHead>Status</TableHead>
              <TableHead className="text-right">Estimate</TableHead><TableHead className="text-right">Accrued</TableHead><TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Allocated</TableHead><TableHead>Source invoice</TableHead><TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {((sources ?? []) as unknown as Array<Record<string, unknown> & { id: string; status: string; inventory_treatment: string; allocation_basis: string;
                estimated_amount: number; accrued_amount: number; actual_amount: number; capitalised_applied: number; include_in_commercial_cost: boolean;
                category: { name: string } | null; supplier: { name: string } | null; actual: { line: { invoice: { id: string; document_number: string; supplier_invoice_number: string } | null } | null }[] }>).map((c) => {
                const due = c.status === "invoiced" ? N(c.actual_amount) : c.status === "accrued" ? N(c.accrued_amount) : 0;
                const unalloc = c.inventory_treatment === "capitalize" && c.status !== "voided" && N(c.capitalised_applied) !== due;
                const inv = c.actual?.[0]?.line?.invoice;
                return (
                  <TableRow key={c.id} className={c.status === "voided" ? "opacity-50" : ""}>
                    <TableCell>{c.category?.name}{c.description ? <span className="text-xs text-muted-foreground"> · {c.description as string}</span> : null}
                      {c.supplier && <p className="text-xs text-muted-foreground">{c.supplier.name}</p>}</TableCell>
                    <TableCell className="text-xs">{c.inventory_treatment === "capitalize" ? "Capitalised" : `Expensed${c.include_in_commercial_cost ? " (in pricing)" : ""}`}</TableCell>
                    <TableCell className="text-xs">{c.allocation_basis}</TableCell>
                    <TableCell><Badge variant={c.status === "invoiced" ? "success" : c.status === "accrued" ? "warning" : "secondary"}>{c.status}</Badge></TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(N(c.estimated_amount))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(N(c.accrued_amount))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(N(c.actual_amount))}</TableCell>
                    <TableCell className={`text-right tabular-nums ${unalloc ? "text-destructive" : ""}`}>{c.inventory_treatment === "capitalize" ? formatMoney(N(c.capitalised_applied)) : "—"}</TableCell>
                    <TableCell className="text-xs">{inv ? `${inv.document_number} (${inv.supplier_invoice_number})` : c.status === "accrued" ? <span className="text-warning">awaiting invoice</span> : "—"}</TableCell>
                    <TableCell>{can(ctx.user, "imports.post") && s.cost_status !== "finalized" && <CostRowActions sourceId={c.id} status={c.status} estimate={N(c.estimated_amount)} />}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {can(ctx.user, "imports.edit_draft") && !["finalized", "adjusted"].includes(s.cost_status) && s.logistics_status !== "cancelled" && (
            <div className="px-5 pb-5">
              <AddCostForm shipmentId={id}
                categories={((categories ?? []) as Array<{ id: string; code: string; name: string; inventory_treatment: string; allocation_basis: string; component: string | null }>)
                  .map((c) => ({ id: c.id, code: c.code, name: c.name, treatment: c.inventory_treatment, basis: c.allocation_basis, component: c.component })) as CategoryOpt[]}
                suppliers={(suppliers ?? []).map((x) => ({ id: x.id, label: `${x.code} — ${x.name}` }))}
                lines={ll.map((l) => ({ id: l.id, label: `${l.line_no}. ${l.product?.name}` }))}
                includesFreight={s.goods_includes_freight} includesInsurance={s.goods_includes_insurance} />
            </div>
          )}
        </CardContent></Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card><CardContent className="p-5 text-sm">
          <h3 className="mb-2 font-semibold">Goods invoices</h3>
          {(invoices ?? []).length === 0 ? <p className="text-muted-foreground">None yet.</p> : (invoices ?? []).map((i) => (
            <div key={i.id} className="flex justify-between border-b border-border py-1 last:border-0">
              <span><Link className="font-mono text-xs underline" href={`/purchases/${i.id}`}>{i.document_number ?? "draft"}</Link> · {i.supplier_invoice_number} · {formatDate(i.document_date)}</span>
              <span className="tabular-nums">{i.currency_code !== "TZS" && <>{i.currency_code} {formatMoney(N(i.fc_grand_total))} @ {N(i.exchange_rate)} · </>}TZS {formatMoney(N(i.grand_total))}</span>
            </div>
          ))}
        </CardContent></Card>
        <Card><CardContent className="p-5 text-sm">
          <h3 className="mb-2 font-semibold">Receipts</h3>
          {(receipts ?? []).length === 0 ? <p className="text-muted-foreground">Nothing received yet.</p> : ((receipts ?? []) as unknown as Array<{ id: string; document_number: string | null; receipt_date: string; branch: { code: string } | null;
            lines: { net_kg_received: number; weighbridge_ref: string | null; batch_code: string | null; is_final: boolean; shortage_kg: number; resolution: string | null; value_tzs: number; cost_delta_tzs: number }[] }>).map((r) => (
            <div key={r.id} className="border-b border-border py-1 last:border-0">
              <div className="flex justify-between"><span className="font-mono text-xs">{r.document_number}</span><span>{formatDate(r.receipt_date)} · {r.branch?.code}</span></div>
              {r.lines.map((x, i) => (
                <p key={i} className="text-xs text-muted-foreground">{formatQuantity(N(x.net_kg_received))} kg · WB {x.weighbridge_ref ?? "—"} · batch {x.batch_code ?? "—"}
                  {x.is_final && " · final"}{N(x.shortage_kg) > 0 && ` · short ${formatQuantity(N(x.shortage_kg))} kg (${x.resolution})`}
                  {showCost && ` · TZS ${formatMoney(N(x.value_tzs) + N(x.cost_delta_tzs))}`}</p>
              ))}
            </div>
          ))}
        </CardContent></Card>
      </div>

      {showCost && (
        <Card><CardContent className="p-5 text-sm">
          <h3 className="mb-2 font-semibold">Source-to-stock traceability</h3>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-1 text-xs uppercase text-muted-foreground">Stock received</p>
              {(movements ?? []).length === 0 ? <p className="text-muted-foreground">—</p> : ((movements ?? []) as unknown as Array<{ source_number: string; qty_in: number; movement_value: number; branch: { code: string } | null; product: { name: string } | null }>).map((m, i) => (
                <p key={i} className="text-xs">{m.source_number} · {m.branch?.code} · {m.product?.name} · {formatQuantity(N(m.qty_in))} @ TZS {formatMoney(N(m.movement_value))}</p>
              ))}
            </div>
            <div>
              <p className="mb-1 text-xs uppercase text-muted-foreground">Journals</p>
              {((journals ?? []) as { id: string; entry_date: string; source_type: string; source_number: string | null; memo: string | null }[]).map((j) => (
                <p key={j.id} className="text-xs">{formatDate(j.entry_date)} · {j.source_type.replace(/_/g, " ")} · {j.source_number ?? ""} · {j.memo}</p>
              ))}
            </div>
          </div>
        </CardContent></Card>
      )}

      <Card><CardContent className="p-5 text-sm">
        <h3 className="mb-2 font-semibold">Finalisation</h3>
        <ul className="mb-3 space-y-1">
          {checkRows.map((c) => <li key={c.check_key} className={c.ok ? "text-success" : "text-muted-foreground"}>{c.ok ? "✓" : "•"} {c.detail}</li>)}
        </ul>
        {can(ctx.user, "imports.finalize_cost") && !["finalized", "adjusted"].includes(s.cost_status) && s.logistics_status !== "cancelled" &&
          <FinalizeButton id={id} ready={checkRows.every((c) => c.ok)} />}
        {["finalized", "adjusted"].includes(s.cost_status) && <p className="text-xs text-muted-foreground">Finalised. Later corrections post as linked cost invoices / credit notes and mark the shipment &quot;Adjusted&quot;.</p>}
      </CardContent></Card>

      {attachmentsOn && (
        <Card><CardContent className="p-5">
          <h3 className="mb-2 text-sm font-semibold">Documents</h3>
          <AttachmentsPanel ownerType="import_shipment" ownerId={id} categories={["bill_of_lading", "packing_list", "customs_entry", "photo", "other"]} />
        </CardContent></Card>
      )}
    </div>
  );
}
