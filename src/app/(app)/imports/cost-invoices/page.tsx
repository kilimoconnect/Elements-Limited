import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Cost Invoices" };

export default async function CostInvoicesPage() {
  await requirePermissionPage("cost_invoices.view");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "imports"))) {
    return <div><PageHeader title="Cost Invoices" /><EmptyState title="Importation is not enabled" /></div>;
  }
  const admin = createAdminClient();
  const { data } = await admin.from("cost_invoices")
    .select("id, document_number, document_date, document_kind, document_status, supplier_invoice_number, net_total, tax_total, grand_total, supplier:suppliers(name), credited:credited_invoice_id(document_number), lines:cost_invoice_lines(cost_source:cost_sources(import_shipment:import_shipments(id, document_number), rebag_order:rebag_orders(id, document_number)))")
    .eq("company_id", ctx.companyId).neq("document_status", "draft").order("document_date", { ascending: false }).limit(300);
  type Row = {
    id: string; document_number: string | null; document_date: string; document_kind: string; document_status: string;
    supplier_invoice_number: string | null; net_total: number; tax_total: number; grand_total: number;
    supplier: { name: string } | null; credited: { document_number: string | null } | null;
    lines: { cost_source: { import_shipment: { id: string; document_number: string | null } | null; rebag_order: { id: string; document_number: string | null } | null } | null }[];
  };
  const rows = (data ?? []) as unknown as Row[];
  return (
    <div>
      <PageHeader title="Cost Invoices" description="Freight, clearing, port, transport and other service invoices (TZS) for import shipments."
        actions={can(ctx.user, "cost_invoices.post") ? <Button asChild><Link href="/imports/cost-invoices/new">New cost invoice</Link></Button> : null} />
      {rows.length === 0 ? <EmptyState title="No cost invoices yet" /> : (
        <Card><CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Number</TableHead><TableHead>Date</TableHead><TableHead>Supplier</TableHead><TableHead>Supplier doc.</TableHead>
              <TableHead>Shipments / rebagging</TableHead><TableHead className="text-right">Net</TableHead><TableHead className="text-right">Tax</TableHead>
              <TableHead className="text-right">Total (TZS)</TableHead><TableHead>Status</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => {
                const ships = new Map<string, string>();
                r.lines.forEach((l) => {
                  const s = l.cost_source?.import_shipment; if (s) ships.set(`/imports/${s.id}`, s.document_number ?? "—");
                  const o = l.cost_source?.rebag_order; if (o) ships.set(`/inventory/rebagging/${o.id}`, o.document_number ?? "—");
                });
                const sign = r.document_kind === "credit_note" ? -1 : 1;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.document_number ?? "—"}
                      {r.document_kind === "credit_note" && <p className="text-xs text-muted-foreground">Credit note for {r.credited?.document_number ?? "—"}</p>}</TableCell>
                    <TableCell>{formatDate(r.document_date)}</TableCell>
                    <TableCell className="text-sm">{r.supplier?.name ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.supplier_invoice_number ?? "—"}</TableCell>
                    <TableCell className="text-xs">{ships.size === 0 ? <span className="text-muted-foreground">Expense only</span> :
                      Array.from(ships).map(([id, no]) => <Link key={id} className="mr-2 font-mono underline" href={id}>{no}</Link>)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(sign * Number(r.net_total))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(sign * Number(r.tax_total))}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{formatMoney(sign * Number(r.grand_total))}</TableCell>
                    <TableCell><Badge variant={r.document_status === "posted" ? "success" : "secondary"}>{r.document_status}</Badge></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}
    </div>
  );
}
