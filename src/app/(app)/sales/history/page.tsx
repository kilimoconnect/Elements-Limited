import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListToolbar } from "@/components/common/list-toolbar";
import { DocStatusBadge, PayStatusBadge, saleStatus } from "@/components/common/doc-status-badge";
import { formatMoney, formatDate } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Sales History" };
const PAGE = 20;
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function SalesHistoryPage(props: { searchParams: SP }) {
  await requirePermissionPage("sales.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();

  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  const pay = typeof sp.pay === "string" ? sp.pay : "";
  const branch = typeof sp.branch === "string" ? sp.branch : "";
  const page = typeof sp.page === "string" ? Math.max(1, parseInt(sp.page, 10) || 1) : 1;
  const from = (page - 1) * PAGE, to = from + PAGE - 1;

  let query = admin.from("sales")
    .select("id, document_number, document_date, net_total, tax_total, grand_total, amount_paid, outstanding, payment_status, document_status, approval_status, customer:customers(name), branch:branches(code)", { count: "exact" })
    .eq("company_id", ctx.companyId)
    .order("created_at", { ascending: false })
    .range(from, to);
  if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  if (branch) query = query.eq("branch_id", branch);
  if (status === "pending_approval" || status === "rejected") query = query.eq("document_status", "draft").eq("approval_status", status === "rejected" ? "rejected" : "pending");
  else if (status === "draft") query = query.eq("document_status", "draft").eq("approval_status", "not_submitted");
  else if (status) query = query.eq("document_status", status);
  if (pay) query = query.eq("payment_status", pay);
  if (q) query = query.ilike("document_number", `%${q}%`);

  const { data, count } = await query;
  const rows = (data ?? []) as unknown as Array<{
    id: string; document_number: string | null; document_date: string; net_total: number; tax_total: number;
    grand_total: number; amount_paid: number; outstanding: number; payment_status: string; document_status: string; approval_status: string;
    customer: { name: string } | null; branch: { code: string } | null;
  }>;
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE));

  const qs = (p: number) => new URLSearchParams({ ...(q && { q }), ...(status && { status }), ...(pay && { pay }), ...(branch && { branch }), page: String(p) }).toString();

  return (
    <div>
      <PageHeader
        title="Sales History"
        description="Sales orders and posted, voided sales."
        actions={<Button asChild><Link href="/sales/new">New Sales Order</Link></Button>}
      />
      <ListToolbar
        searchValue={q}
        searchPlaceholder="Search invoice number..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branch, width: "w-[150px]", options: ctx.branches.map((b) => ({ value: b.id, label: b.code })) },
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [
            { value: "draft", label: "Draft" }, { value: "pending_approval", label: "Awaiting approval" }, { value: "rejected", label: "Rejected" }, { value: "posted", label: "Posted" }, { value: "voided", label: "Voided" }] },
          { name: "pay", placeholder: "All payments", value: pay, width: "w-[160px]", options: [
            { value: "unpaid", label: "Unpaid" }, { value: "partially_paid", label: "Partial" }, { value: "paid", label: "Paid" },
            { value: "partially_refunded", label: "Part. refunded" }, { value: "refunded", label: "Refunded" }] },
        ]}
      />

      {rows.length === 0 ? (
        <EmptyState title="No sales found" />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-sm">{formatDate(r.document_date)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.document_number ?? <Badge variant="muted">Order</Badge>}</TableCell>
                  <TableCell className="text-sm">{r.branch?.code}</TableCell>
                  <TableCell className="text-sm">{r.customer?.name ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.grand_total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.outstanding)}</TableCell>
                  <TableCell><PayStatusBadge status={r.payment_status} /></TableCell>
                  <TableCell><DocStatusBadge status={saleStatus(r.document_status, r.approval_status)} /></TableCell>
                  <TableCell className="text-right">
                    <Link href={`/sales/${r.id}`} className="text-sm font-medium text-primary hover:underline">Open</Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {total > PAGE && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>{from + 1}–{Math.min(page * PAGE, total)} of {total}</span>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" disabled={page <= 1}><Link href={`/sales/history?${qs(page - 1)}`}><ChevronLeft className="h-4 w-4" /> Prev</Link></Button>
            <span>Page {page} of {totalPages}</span>
            <Button asChild variant="outline" size="sm" disabled={page >= totalPages}><Link href={`/sales/history?${qs(page + 1)}`}>Next <ChevronRight className="h-4 w-4" /></Link></Button>
          </div>
        </div>
      )}
    </div>
  );
}
