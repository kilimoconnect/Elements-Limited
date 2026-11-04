import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { postManualJournal, deleteManualJournalDraft, voidManualJournal } from "@/lib/accounting/actions";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { TxnActions } from "@/components/common/txn-actions";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClickableRow } from "@/components/common/clickable-row";

export const metadata: Metadata = { title: "Journal Entries" };

export default async function JournalsPage() {
  await requirePermissionPage("accounting.view_journals");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canPost = can(ctx.user, "accounting.post_manual_journal");
  const canOwner = can(ctx.user, "transactions.void");

  const { data: rows } = await admin.from("manual_journal_drafts")
    .select("id, document_number, journal_date, reference, description, total_debit, document_status, is_control_adjustment")
    .eq("company_id", ctx.companyId).order("created_at", { ascending: false }).limit(100);
  const list = (rows ?? []) as unknown as Array<{ id: string; document_number: string | null; journal_date: string; reference: string | null; description: string | null; total_debit: number; document_status: string; is_control_adjustment: boolean }>;

  return (
    <div>
      <PageHeader title="Journal Entries" description="Manual journals. Automatic journals from operational modules appear in the General Ledger."
        actions={can(ctx.user, "accounting.create_manual_journal") ? <Button asChild><Link href="/accounting/journals/new">New Journal</Link></Button> : null} />
      {list.length === 0 ? <EmptyState title="No manual journals yet" /> : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Journal</TableHead><TableHead>Date</TableHead><TableHead>Description</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead className="w-10 text-right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>
              {list.map((r) => (
                <ClickableRow key={r.id} href={`/accounting/journals/${r.id}`}>
                  <TableCell className="font-mono text-xs">{r.document_number ?? <Badge variant="muted">Draft</Badge>}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.journal_date)}</TableCell>
                  <TableCell className="text-sm">{r.description ?? r.reference ?? "—"}{r.is_control_adjustment && <Badge variant="warning" className="ml-2">control</Badge>}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.total_debit)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right">
                    <TxnActions id={r.id} status={r.document_status} canPost={canPost} canOwner={canOwner}
                      postAction={postManualJournal} deleteAction={deleteManualJournalDraft} voidAction={voidManualJournal}
                      postLabel="Post journal" afterDeletePush="/accounting/journals"
                      extraItems={[{ label: "View", href: `/accounting/journals/${r.id}` }]} />
                  </TableCell>
                </ClickableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
