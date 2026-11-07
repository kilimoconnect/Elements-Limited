import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { formatMoney, formatDate } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ReceiptActions } from "./receipt-actions";
import { ClickableRow } from "@/components/common/clickable-row";

export const metadata: Metadata = { title: "Customer Payments" };

export default async function CustomerPaymentsPage() {
  await requirePermissionPage("sales.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canVoid = can(ctx.user, "transactions.void");

  const { data: rows } = await admin.from("customer_receipts")
    .select("id, document_number, document_date, amount, reference, document_status, customer:customers(name), branch:branches(code), account:payment_accounts(name)")
    .eq("company_id", ctx.companyId).order("created_at", { ascending: false }).limit(100);
  const list = (rows ?? []) as unknown as Array<{
    id: string; document_number: string | null; document_date: string; amount: number; reference: string | null;
    document_status: string; customer: { name: string } | null; branch: { code: string } | null; account: { name: string } | null;
  }>;

  return (
    <div>
      <PageHeader
        title="Customer Payments"
        description="Payments received from customers. Open one to see what it paid and its proof of payment."
        actions={can(ctx.user, "sales.receive_payment") && <Button asChild><Link href="/sales/customer-payments/new">Receive Payment</Link></Button>}
      />
      {list.length === 0 ? (
        <EmptyState title="No receipts yet" />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Receipt</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => (
                <ClickableRow key={r.id} href={`/sales/customer-payments/${r.id}`}>
                  <TableCell className="font-mono text-xs">{r.document_number ?? "—"}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.document_date)}</TableCell>
                  <TableCell className="text-sm">{r.customer?.name}</TableCell>
                  <TableCell className="text-sm">{r.branch?.code}</TableCell>
                  <TableCell className="text-sm">{r.account?.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.amount)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right"><ReceiptActions id={r.id} status={r.document_status} canVoid={canVoid} /></TableCell>
                </ClickableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
