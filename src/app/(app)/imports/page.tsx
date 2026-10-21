import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { shipmentSummaries, LOGISTICS_LABEL, COST_LABEL } from "@/lib/imports/queries";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatQuantity } from "@/lib/format";

export const metadata: Metadata = { title: "Import Shipments" };

export default async function ImportsPage() {
  await requirePermissionPage("imports.view");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "imports"))) {
    return <div><PageHeader title="Import Shipments" /><EmptyState title="Importation is not enabled" description="Enable it under Admin → Feature Flags." /></div>;
  }
  const rows = await shipmentSummaries(ctx.companyId);
  const open = rows.filter((r) => !["closed", "cancelled"].includes(r.logistics_status));
  const awaiting = rows.reduce((a, r) => a + r.awaiting_invoice, 0);
  const unallocated = rows.reduce((a, r) => a + r.unallocated, 0);
  const inTransit = open.reduce((a, r) => a + r.in_transit_kg, 0);

  return (
    <div>
      <PageHeader title="Import Shipments" description="Bulk imports from order to landed cost: invoices, costs, receipts and finalisation."
        actions={can(ctx.user, "imports.create") ? <Button asChild><Link href="/imports/new">New shipment</Link></Button> : null} />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4"><p className="text-xs text-muted-foreground">Open shipments</p><p className="text-lg font-semibold tabular-nums">{open.length}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">In transit</p><p className="text-lg font-semibold tabular-nums">{formatQuantity(inTransit / 1000)} MT</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Costs awaiting invoice</p><p className={`text-lg font-semibold tabular-nums ${awaiting ? "text-warning" : ""}`}>{awaiting}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Unallocated costs</p><p className={`text-lg font-semibold tabular-nums ${unallocated ? "text-destructive" : ""}`}>{unallocated}</p></Card>
      </div>
      {rows.length === 0 ? <EmptyState title="No import shipments yet" /> : (
        <Card><CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Shipment</TableHead><TableHead>Supplier</TableHead><TableHead>Terms</TableHead><TableHead>B/L</TableHead>
              <TableHead className="text-right">Expected MT</TableHead><TableHead className="text-right">Received MT</TableHead>
              <TableHead>Logistics</TableHead><TableHead>Costing</TableHead><TableHead>Open items</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell><Link className="font-mono text-xs underline" href={`/imports/${r.id}`}>{r.document_number ?? "—"}</Link>
                    {r.eta && <p className="text-xs text-muted-foreground">ETA {formatDate(r.eta)}</p>}</TableCell>
                  <TableCell className="text-sm">{r.supplier}</TableCell>
                  <TableCell className="text-sm">{r.incoterm} {r.named_place}<span className="text-xs text-muted-foreground"> · {r.currency_code}</span></TableCell>
                  <TableCell className="font-mono text-xs">{r.bill_of_lading ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(r.expected_kg / 1000)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(r.received_kg / 1000)}</TableCell>
                  <TableCell><Badge variant={r.logistics_status === "closed" ? "success" : r.logistics_status === "cancelled" ? "secondary" : "warning"}>{LOGISTICS_LABEL[r.logistics_status]}</Badge></TableCell>
                  <TableCell><Badge variant={r.cost_status === "finalized" ? "success" : "secondary"}>{COST_LABEL[r.cost_status]}</Badge></TableCell>
                  <TableCell className="text-xs">
                    {r.goods_uninvoiced && r.logistics_status !== "cancelled" && <p>Goods not fully invoiced</p>}
                    {r.awaiting_invoice > 0 && <p className="text-warning">{r.awaiting_invoice} cost(s) awaiting invoice</p>}
                    {r.unallocated > 0 && <p className="text-destructive">{r.unallocated} unallocated</p>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}
    </div>
  );
}
