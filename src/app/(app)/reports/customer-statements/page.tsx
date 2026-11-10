import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { customerStatement } from "@/lib/reports/subledger";
import { resolvePeriod, type SP } from "@/lib/reports/period";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { PeriodFilter, PrintButton, ParamSelect } from "@/components/reports/report-tools";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MaybeClickableRow } from "@/components/common/clickable-row";

export const metadata: Metadata = { title: "Customer Statement" };

export default async function CustomerStatementsPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("reports.view_receivables");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const { start, end } = resolvePeriod(sp);
  const customerId = typeof sp.customer === "string" ? sp.customer : "";
  const admin = createAdminClient();
  const { data: customers } = await admin.from("customers").select("id, code, name").eq("company_id", ctx.companyId).order("code");
  const cust = customerId ? (customers ?? []).find((c) => c.id === customerId) : null;
  const st = cust ? await customerStatement(ctx.companyId, customerId, start, end) : null;

  return (
    <div>
      <PageHeader title="Customer Statement" description={cust ? `${cust.name} · ${formatDate(start)} → ${formatDate(end)}` : "Select a customer"} actions={st ? <PrintButton /> : null} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <ParamSelect param="customer" value={customerId} placeholder="Select customer" options={(customers ?? []).map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }))} />
        <PeriodFilter start={start} end={end} />
      </div>
      {cust && <p className="mb-2 text-xs text-muted-foreground">Invoices are debits; payments, returns and advances received are credits. A negative balance is money the customer has paid in advance.</p>}
      {!cust ? <EmptyState title="Choose a customer" /> : (
        <div className="report-card rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Document</TableHead><TableHead>Type</TableHead><TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead><TableHead className="text-right">Balance</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow><TableCell colSpan={5} className="text-sm font-medium">Opening balance</TableCell><TableCell className="text-right tabular-nums font-medium">{formatMoney(st!.opening)}</TableCell></TableRow>
              {st!.rows.map((r, i) => (
                <MaybeClickableRow key={i} href={r.href ?? null}>
                  <TableCell className="text-sm">{formatDate(r.date)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.doc}</TableCell>
                  <TableCell className="text-sm">{r.type}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.debit ? formatMoney(r.debit) : ""}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.credit ? formatMoney(r.credit) : ""}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.running)}</TableCell>
                </MaybeClickableRow>
              ))}
              <TableRow className="font-semibold"><TableCell colSpan={5}>Closing balance{st!.closing < 0 ? " (customer credit: paid in advance)" : ""}</TableCell><TableCell className="text-right tabular-nums">{formatMoney(st!.closing)}</TableCell></TableRow>
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
