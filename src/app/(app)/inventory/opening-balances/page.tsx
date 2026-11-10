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
import { NewOpeningButton } from "./opening-form";
import { InventoryDocActions } from "@/components/inventory/doc-actions";
import { DocStatusBadge } from "@/components/common/doc-status-badge";

export const metadata: Metadata = { title: "Opening Balances" };

export default async function OpeningBalancesPage() {
  await requirePermissionPage("inventory.opening_balance");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canOwner = can(ctx.user, "transactions.void");

  const { data: products } = await admin.from("products")
    .select("id, sku, name").eq("company_id", ctx.companyId).eq("is_active", true).order("sku");

  const { data: rows } = await admin.from("inventory_openings")
    .select("id, document_number, opening_date, reference, total_cost, document_status, branch:branches(code, name)")
    .eq("company_id", ctx.companyId).order("created_at", { ascending: false }).limit(100);
  const list = (rows ?? []) as unknown as Array<{
    id: string; document_number: string | null; opening_date: string; reference: string | null;
    total_cost: number; document_status: string; branch: { code: string; name?: string } | null;
  }>;

  return (
    <div>
      <PageHeader
        title="Opening Balances"
        description="Load starting inventory. Posting creates stock-in movements and a balanced journal."
        actions={ctx.branchId && <NewOpeningButton products={(products ?? []) as never} branchId={ctx.branchId} />}
      />
      {list.length === 0 ? (
        <EmptyState title="No opening balances yet" description="Create one to load your starting stock." />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Total cost</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.document_number ?? <Badge variant="muted">Draft</Badge>}</TableCell>
                  <TableCell className="text-sm">{r.branch?.name ?? r.branch?.code}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.opening_date)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.reference ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.total_cost)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right">
                    <InventoryDocActions kind="opening" id={r.id} status={r.document_status} canPost canOwner={canOwner} />
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
