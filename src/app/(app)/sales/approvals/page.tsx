import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, formatDate, formatDateTime } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Sales Approvals" };

/** Sales orders awaiting approval in the branches the approver works in, oldest first. */
export default async function SalesApprovalsPage() {
  await requirePermissionPage("sales.approve");
  const ctx = await getActiveContext();
  const admin = createAdminClient();

  let query = admin.from("sales")
    .select("id, document_date, grand_total, amount_paid, outstanding, submitted_by, submitted_at, customer:customers(name), branch:branches(code)")
    .eq("company_id", ctx.companyId).eq("document_status", "draft").eq("approval_status", "pending")
    .order("submitted_at", { ascending: true });
  if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  const { data } = await query;
  const rows = (data ?? []) as unknown as Array<{
    id: string; document_date: string; grand_total: number; amount_paid: number; outstanding: number;
    submitted_by: string | null; submitted_at: string | null;
    customer: { name: string } | null; branch: { code: string } | null;
  }>;

  const ids = rows.map((r) => r.id);
  const submitters = [...new Set(rows.map((r) => r.submitted_by).filter(Boolean))] as string[];
  const [{ data: proofs }, { data: profiles }] = await Promise.all([
    ids.length
      ? admin.from("document_attachments").select("owner_id").eq("owner_type", "sale").eq("category", "proof_of_payment").in("owner_id", ids)
      : Promise.resolve({ data: [] as { owner_id: string }[] }),
    submitters.length
      ? admin.from("user_profiles").select("id, full_name, email").in("id", submitters)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null; email: string }[] }),
  ]);
  const withProof = new Set((proofs ?? []).map((p) => p.owner_id));
  const nameOf = (uid: string | null) => { const p = (profiles ?? []).find((x) => x.id === uid); return p ? (p.full_name || p.email) : "—"; };

  return (
    <div>
      <PageHeader title="Sales Approvals" description="Sales orders waiting for your approval. Approving an order posts the sale." />
      {rows.length === 0 ? (
        <EmptyState title="Nothing to approve" description="New sales orders appear here when they are submitted." />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Submitted</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Order date</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead>Proof</TableHead>
                <TableHead className="text-right">Review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-sm">{r.submitted_at ? formatDateTime(r.submitted_at) : "—"}</TableCell>
                  <TableCell className="text-sm">{nameOf(r.submitted_by)}</TableCell>
                  <TableCell className="text-sm">{r.branch?.code}</TableCell>
                  <TableCell className="text-sm">{r.customer?.name ?? "—"}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.document_date)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.grand_total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.amount_paid)}</TableCell>
                  <TableCell>
                    {Number(r.amount_paid) <= 0 ? <Badge variant="muted">Credit</Badge>
                      : withProof.has(r.id) ? <Badge variant="success">Attached</Badge> : <Badge variant="destructive">Missing</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link href={`/sales/${r.id}`} className="text-sm font-medium text-primary hover:underline">Review</Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
