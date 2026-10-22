import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PrintButton } from "@/components/reports/report-tools";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Cost Reconciliation" };

const MONEY = new Set(["inventory_gl", "transit_gl", "import_transit_gl", "grir", "accruals", "ap", "supplier_credits"]);

export default async function CostReconciliationPage() {
  await requirePermissionPage("reports.view_inventory_valuation");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("cost_reconciliation_checks", { p_company: ctx.companyId });
  const rows = (data ?? []) as { check_key: string; label: string; ok: boolean; expected: number; actual: number; detail: string }[];
  const failing = rows.filter((r) => !r.ok).length;
  return (
    <div>
      <PageHeader title="Cost Reconciliation" description="Current-position checks for the costing engine: quantities conserved, allocations complete, subledgers equal the GL, and clearing accounts holding only explained open items."
        actions={<PrintButton />} />
      <Card className="mb-4"><CardContent className="p-4 text-sm">
        {error ? <span className="text-destructive">Could not run the checks: {error.message}</span>
          : failing === 0 ? <Badge variant="success">All {rows.length} checks reconcile</Badge> : <Badge variant="destructive">{failing} check(s) need attention</Badge>}
      </CardContent></Card>
      <Card><CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Check</TableHead><TableHead className="text-right">Subledger / expected</TableHead><TableHead className="text-right">GL / actual</TableHead><TableHead>Detail</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.check_key}>
                <TableCell>{r.label}</TableCell>
                <TableCell className="text-right tabular-nums">{MONEY.has(r.check_key) ? formatMoney(Number(r.expected)) : Number(r.expected)}</TableCell>
                <TableCell className="text-right tabular-nums">{MONEY.has(r.check_key) ? formatMoney(Number(r.actual)) : Number(r.actual)}</TableCell>
                <TableCell className="max-w-96 text-xs text-muted-foreground">{r.detail}</TableCell>
                <TableCell>{r.ok ? <Badge variant="success">OK</Badge> : <Badge variant="destructive">Difference</Badge>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent></Card>
    </div>
  );
}
