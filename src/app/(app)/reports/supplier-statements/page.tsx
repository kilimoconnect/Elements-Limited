import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { supplierStatement } from "@/lib/reports/subledger";
import { resolvePeriod, type SP } from "@/lib/reports/period";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { PeriodFilter, PrintButton, ParamSelect } from "@/components/reports/report-tools";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MaybeClickableRow } from "@/components/common/clickable-row";

export const metadata: Metadata = { title: "Supplier Statement" };

export default async function SupplierStatementsPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("reports.view_payables");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const { start, end } = resolvePeriod(sp);
  const supplierId = typeof sp.supplier === "string" ? sp.supplier : "";
  const admin = createAdminClient();
  const { data: suppliers } = await admin.from("suppliers").select("id, code, name").eq("company_id", ctx.companyId).order("code");
  const sup = supplierId ? (suppliers ?? []).find((c) => c.id === supplierId) : null;
  const st = sup ? await supplierStatement(ctx.companyId, supplierId, start, end) : null;

  return (
    <div>
      <PageHeader title="Supplier Statement" description={sup ? `${sup.name} · ${formatDate(start)} → ${formatDate(end)}` : "Select a supplier"} actions={st ? <PrintButton /> : null} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <ParamSelect param="supplier" value={supplierId} placeholder="Select supplier" options={(suppliers ?? []).map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }))} />
        <PeriodFilter start={start} end={end} />
      </div>
      {!sup ? <EmptyState title="Choose a supplier" /> : (
        <div className="space-y-6">
          <StatementTable title={st!.foreign.length ? "TZS" : null} st={st!} currency="TZS" />
          {st!.foreign.map((f) => (
            <div key={f.currency} className="space-y-2">
              <StatementTable title={`${f.currency} invoices (amounts in ${f.currency}, with TZS value)`} st={f} currency={f.currency} />
              <p className="text-sm text-muted-foreground">
                TZS carrying amount of open {f.currency} invoices at {formatDate(end)}: <span className="font-medium text-foreground tabular-nums">{formatMoney(f.carryingOpenInvoices)}</span>
                {" "}(original rate, updated by revaluations and settlements). Unapplied advances and credits are shown in {f.currency} above.
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Statement = { opening: number; closing: number; tzsOpening?: number; tzsClosing?: number;
  rows: { date: string; doc: string; type: string; debit: number; credit: number; running: number; tzs?: number; tzsRunning?: number; href?: string | null }[] };

function StatementTable({ title, st, currency }: { title: string | null; st: Statement; currency: string }) {
  const fc = currency !== "TZS";
  const m = (v: number) => formatMoney(v, currency);
  return (
    <div className="report-card rounded-lg border border-border bg-card">
      {title && <h3 className="px-4 pt-3 text-sm font-semibold">{title}</h3>}
      <Table>
        <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Document</TableHead><TableHead>Type</TableHead><TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead><TableHead className="text-right">Balance</TableHead>
          {fc && <><TableHead className="text-right">TZS value</TableHead><TableHead className="text-right">TZS balance</TableHead></>}</TableRow></TableHeader>
        <TableBody>
          <TableRow><TableCell colSpan={5} className="text-sm font-medium">Opening balance</TableCell><TableCell className="text-right tabular-nums font-medium">{m(st.opening)}</TableCell>
            {fc && <><TableCell /><TableCell className="text-right tabular-nums font-medium">{formatMoney(st.tzsOpening ?? 0)}</TableCell></>}</TableRow>
          {st.rows.map((r, i) => (
            <MaybeClickableRow key={i} href={r.href ?? null}>
              <TableCell className="text-sm">{formatDate(r.date)}</TableCell>
              <TableCell className="font-mono text-xs">{r.doc}</TableCell>
              <TableCell className="text-sm">{r.type}</TableCell>
              <TableCell className="text-right tabular-nums">{r.debit ? m(r.debit) : ""}</TableCell>
              <TableCell className="text-right tabular-nums">{r.credit ? m(r.credit) : ""}</TableCell>
              <TableCell className="text-right tabular-nums">{m(r.running)}</TableCell>
              {fc && <><TableCell className="text-right tabular-nums text-muted-foreground">{r.tzs ? formatMoney(Math.abs(r.tzs)) : ""}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(r.tzsRunning ?? 0)}</TableCell></>}
            </MaybeClickableRow>
          ))}
          <TableRow className="font-semibold"><TableCell colSpan={5}>Closing balance</TableCell><TableCell className="text-right tabular-nums">{m(st.closing)}</TableCell>
            {fc && <><TableCell /><TableCell className="text-right tabular-nums">{formatMoney(st.tzsClosing ?? 0)}</TableCell></>}</TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
