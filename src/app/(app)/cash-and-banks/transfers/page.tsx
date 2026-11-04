import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { postTransfer, deleteTransferDraft, voidTransfer } from "@/lib/cash/actions";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { TxnActions } from "@/components/common/txn-actions";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClickableRow } from "@/components/common/clickable-row";

export const metadata: Metadata = { title: "Transfers" };

export default async function TransfersPage() {
  await requirePermissionPage("cash_transfers.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canPost = can(ctx.user, "cash_transfers.post");
  const canOwner = can(ctx.user, "transactions.void");

  const { data: rows } = await admin.from("cash_transfers")
    .select("id, document_number, transfer_date, amount, fee, document_status, reference, source:payment_accounts!cash_transfers_source_account_id_fkey(name), dest:payment_accounts!cash_transfers_destination_account_id_fkey(name)")
    .eq("company_id", ctx.companyId).order("created_at", { ascending: false }).limit(100);
  const list = (rows ?? []) as unknown as Array<{ id: string; document_number: string | null; transfer_date: string; amount: number; fee: number; document_status: string; reference: string | null; source: { name: string } | null; dest: { name: string } | null }>;

  return (
    <div>
      <PageHeader title="Cash Transfers" actions={<Button asChild><Link href="/cash-and-banks/transfer">New Transfer</Link></Button>} />
      {list.length === 0 ? <EmptyState title="No transfers yet" /> : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Document</TableHead><TableHead>Date</TableHead><TableHead>From → To</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Fee</TableHead><TableHead>Status</TableHead><TableHead className="w-10 text-right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>
              {list.map((r) => (
                <ClickableRow key={r.id} href={`/cash-and-banks/transfers/${r.id}`}>
                  <TableCell className="font-mono text-xs">{r.document_number ?? <Badge variant="muted">Draft</Badge>}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.transfer_date)}</TableCell>
                  <TableCell className="text-sm">{r.source?.name} → {r.dest?.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatMoney(r.fee)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right">
                    <TxnActions id={r.id} status={r.document_status} canPost={canPost} canOwner={canOwner}
                      postAction={postTransfer} deleteAction={deleteTransferDraft} voidAction={voidTransfer} afterDeletePush="/cash-and-banks/transfers"
                      postLabel="Post transfer" extraItems={[{ label: "View", href: `/cash-and-banks/transfers/${r.id}` }]} />
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
