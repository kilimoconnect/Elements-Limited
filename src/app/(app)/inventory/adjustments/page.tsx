import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, formatDate } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { NewAdjustmentButton } from "./adjustment-form";
import { InventoryDocActions } from "@/components/inventory/doc-actions";
import { DocStatusBadge } from "@/components/common/doc-status-badge";

export const metadata: Metadata = { title: "Stock Adjustments" };

export default async function AdjustmentsPage() {
  await requirePermissionPage("inventory.adjustment_create");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canPost = can(ctx.user, "inventory.adjustment_post");
  const canOwner = can(ctx.user, "transactions.void");

  const { data: products } = await admin.from("products")
    .select("id, sku, name").eq("company_id", ctx.companyId).eq("is_active", true).order("sku");

  const { data: rows } = await admin.from("stock_adjustments")
    .select("id, document_number, adjustment_date, direction, reason, total_value, document_status, branch:branches(code, name)")
    .eq("company_id", ctx.companyId).order("created_at", { ascending: false }).limit(100);
  const list = (rows ?? []) as unknown as Array<{
    id: string; document_number: string | null; adjustment_date: string; direction: string;
    reason: string; total_value: number; document_status: string; branch: { code: string; name?: string } | null;
  }>;

  return (
    <div>
      <PageHeader
        title="Stock Adjustments"
        description="Correct stock for damage, loss, counts and data fixes."
        actions={ctx.branchId && <NewAdjustmentButton products={(products ?? []) as never} branchId={ctx.branchId} canPost={canPost} />}
      />
      {list.length === 0 ? (
        <EmptyState title="No adjustments yet" />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.document_number ?? <Badge variant="muted">Draft</Badge>}</TableCell>
                  <TableCell className="text-sm">{r.branch?.name ?? r.branch?.code}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.adjustment_date)}</TableCell>
                  <TableCell><Badge variant={r.direction === "increase" ? "success" : "warning"}>{r.direction === "increase" ? "Increase" : "Decrease"}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.reason}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.total_value)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right">
                    <InventoryDocActions kind="adjustment" id={r.id} status={r.document_status} canPost={canPost} canOwner={canOwner} />
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
