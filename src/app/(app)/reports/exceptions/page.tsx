import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { type SP } from "@/lib/reports/period";
import { exceptions } from "@/lib/reports/costing";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ParamSelect, PrintButton, ExportCsvButton } from "@/components/reports/report-tools";
import { Pager, PAGE_SIZE, pageOf, str } from "@/components/reports/pager";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "Costing Exceptions" };

export default async function ExceptionsPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("inventory.view_cost");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const kind = str(sp, "kind");
  const page = pageOf(sp);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Dar_es_Salaam" }).format(new Date());
  const everything = await exceptions(createAdminClient(), ctx.companyId, ctx.user.isOwner ? null : ctx.user.branchIds, today);
  const kinds = Array.from(new Set(everything.map((e) => e.kind))).sort();
  const all = everything.filter((e) => !kind || e.kind === kind).sort((a, b) => (a.severity === b.severity ? a.kind.localeCompare(b.kind) : a.severity === "high" ? -1 : 1));
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return (
    <div>
      <PageHeader title="Costing Exceptions" description="Open items needing attention: unfinalised costs, unallocated charges, unresolved losses, missing documents, overdue arrivals, unmatched accruals (older than 30 days) and stock / GL differences. Current position."
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename="costing-exceptions.csv" header={["Severity", "Exception", "Document", "Detail", "Since"]}
          rows={all.map((e) => [e.severity, e.kind, e.document, e.detail, e.since ?? ""])} /></div>} />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {kinds.map((k) => (
          <Card key={k} className="p-4"><p className="text-xs text-muted-foreground">{k}</p><p className="text-lg font-semibold tabular-nums">{everything.filter((e) => e.kind === k).length}</p></Card>
        ))}
      </div>
      <div className="mb-4"><ParamSelect param="kind" value={kind} placeholder="All exceptions" options={kinds.map((k) => ({ id: k, label: k }))} /></div>
      {all.length === 0 ? <EmptyState title="No exceptions" description="Everything reconciles and nothing is overdue." /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Severity</TableHead><TableHead>Exception</TableHead><TableHead>Document</TableHead><TableHead>Detail</TableHead><TableHead>Since</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((e, i) => (
                <TableRow key={i}>
                  <TableCell><Badge variant={e.severity === "high" ? "destructive" : "warning"}>{e.severity}</Badge></TableCell>
                  <TableCell className="text-sm">{e.kind}</TableCell>
                  <TableCell className="text-sm">{e.href ? <Link className="underline" href={e.href}>{e.document}</Link> : e.document}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{e.detail}</TableCell>
                  <TableCell className="text-xs">{e.since ? formatDate(e.since) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <Pager basePath="/reports/exceptions" params={{ kind }} page={page} pageSize={PAGE_SIZE} total={all.length} />
    </div>
  );
}
