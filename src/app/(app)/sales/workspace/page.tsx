import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ClickableRow } from "@/components/common/clickable-row";
import { StatusBadge } from "@/components/sales/sales-ui";
import { REQUEST_STATUS, ORDER_STATUS, SHIPMENT_STATUS } from "@/lib/sales/fulfilment-data";
import { formatMoney, formatDateTime } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Sales Workspace" };

/** Sales Officer workspace: requests, approved orders to fulfil, trucks on the road. */
export default async function SalesWorkspacePage() {
  await requirePermissionPage("sales.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const bids = ctx.branches.map((b) => b.id);

  const [{ data: requests }, { data: orders }, { data: trucks }] = await Promise.all([
    (admin.from("sales_requests").select("id, document_number, status, grand_total, updated_at, decision_reason, customer:customers(name)")
      .eq("company_id", ctx.companyId).in("branch_id", bids).in("status", ["draft", "pending_approval", "returned"]).order("updated_at", { ascending: false }).limit(100)),
    (admin.from("sales_orders").select("id, document_number, status, on_hold, grand_total, approved_at, customer:customers(name), lines:sales_order_lines(quantity, qty_dispatched, qty_allocated, track_inventory)")
      .eq("company_id", ctx.companyId).in("branch_id", bids).in("status", ["approved", "in_fulfilment"]).order("approved_at")),
    (admin.from("sales_shipments").select("id, document_number, status, vehicle_registration, collector_name, dispatched_at, created_at, payment_flag, order:sales_orders(document_number, customer:customers(name))")
      .eq("company_id", ctx.companyId).in("branch_id", bids).in("status", ["planned", "loading_order_issued", "loaded", "dispatched", "in_transit"]).order("created_at")),
  ]);
  type Rq = { id: string; document_number: string | null; status: string; grand_total: number; updated_at: string; decision_reason: string | null; customer: { name: string } | null };
  type Or = { id: string; document_number: string; status: string; on_hold: boolean; grand_total: number; approved_at: string; customer: { name: string } | null;
    lines: { quantity: number; qty_dispatched: number; qty_allocated: number; track_inventory: boolean }[] };
  type Tr = { id: string; document_number: string; status: string; vehicle_registration: string | null; collector_name: string | null; dispatched_at: string | null; created_at: string; payment_flag: boolean;
    order: { document_number: string; customer: { name: string } | null } | null };
  const rq = (requests ?? []) as unknown as Rq[];
  const or = (orders ?? []) as unknown as Or[];
  const tr = (trucks ?? []) as unknown as Tr[];
  const active = tr.filter((t) => ["planned", "loading_order_issued", "loaded"].includes(t.status));
  const onRoad = tr.filter((t) => ["dispatched", "in_transit"].includes(t.status));

  const reqTable = (rows: Rq[], empty: string) => rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{empty}</p> : (
    <Table>
      <TableHeader><TableRow><TableHead>Request</TableHead><TableHead>Customer</TableHead><TableHead className="text-right">Value</TableHead><TableHead>Status</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((r) => (
        <ClickableRow key={r.id} href={`/sales/requests/${r.id}`}>
          <TableCell className="text-sm font-medium">{r.document_number ?? "Draft"}</TableCell>
          <TableCell className="text-sm">{r.customer?.name}{r.decision_reason && r.status === "returned" && <span className="block text-xs text-destructive">{r.decision_reason}</span>}</TableCell>
          <TableCell className="text-right tabular-nums">{formatMoney(r.grand_total)}</TableCell>
          <TableCell><StatusBadge map={REQUEST_STATUS} status={r.status} /></TableCell>
          <TableCell className="text-xs">{formatDateTime(r.updated_at)}</TableCell>
        </ClickableRow>
      ))}</TableBody>
    </Table>
  );
  const truckTable = (rows: Tr[], empty: string) => rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{empty}</p> : (
    <Table>
      <TableHeader><TableRow><TableHead>Truck</TableHead><TableHead>Order</TableHead><TableHead>Vehicle / collector</TableHead><TableHead>Status</TableHead><TableHead>Since</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((t) => (
        <ClickableRow key={t.id} href={`/sales/shipments/${t.id}`}>
          <TableCell className="text-sm font-medium">{t.document_number}{t.payment_flag && <Badge variant="destructive" className="ml-2">Payment issue</Badge>}</TableCell>
          <TableCell className="text-sm">{t.order?.document_number}<span className="block text-xs text-muted-foreground">{t.order?.customer?.name}</span></TableCell>
          <TableCell className="text-sm">{t.vehicle_registration ?? t.collector_name ?? "—"}</TableCell>
          <TableCell><StatusBadge map={SHIPMENT_STATUS} status={t.status} /></TableCell>
          <TableCell className="text-xs">{formatDateTime(t.dispatched_at ?? t.created_at)}</TableCell>
        </ClickableRow>
      ))}</TableBody>
    </Table>
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Sales Workspace" description="Your requests, approved orders to load and trucks to follow up."
        actions={can(ctx.user, "sales.create") ? <Button asChild><Link href="/sales/new"><Plus className="h-4 w-4" /> New Sales Request</Link></Button> : undefined} />
      <Section title="Returned for correction" count={rq.filter((r) => r.status === "returned").length}>{reqTable(rq.filter((r) => r.status === "returned"), "Nothing returned.")}</Section>
      <Section title="Drafts" count={rq.filter((r) => r.status === "draft").length}>{reqTable(rq.filter((r) => r.status === "draft"), "No drafts.")}</Section>
      <Section title="Awaiting approval" count={rq.filter((r) => r.status === "pending_approval").length}>{reqTable(rq.filter((r) => r.status === "pending_approval"), "Nothing waiting for a manager.")}</Section>
      <Section title="Approved orders to fulfil" count={or.length}>
        {or.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No open orders.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>Order</TableHead><TableHead>Customer</TableHead><TableHead className="text-right">Value</TableHead><TableHead className="text-right">To allocate</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
            <TableBody>{or.map((o) => {
              const left = o.lines.filter((l) => l.track_inventory).reduce((s, l) => s + Math.max(Number(l.quantity) - Number(l.qty_dispatched) - Number(l.qty_allocated), 0), 0);
              return (
                <ClickableRow key={o.id} href={`/sales/orders/${o.id}`}>
                  <TableCell className="text-sm font-medium">{o.document_number}</TableCell>
                  <TableCell className="text-sm">{o.customer?.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(o.grand_total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{left.toLocaleString("en-US", { maximumFractionDigits: 4 })}</TableCell>
                  <TableCell><StatusBadge map={ORDER_STATUS} status={o.status} />{o.on_hold && <Badge variant="destructive" className="ml-1">On hold</Badge>}</TableCell>
                </ClickableRow>
              );
            })}</TableBody>
          </Table>
        )}
      </Section>
      <Section title="Active trucks (before dispatch)" count={active.length}>{truckTable(active, "No trucks being loaded.")}</Section>
      <Section title="Delivery / collection follow-up" count={onRoad.length}>{truckTable(onRoad, "No dispatched trucks waiting for confirmation.")}</Section>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">{title} <Badge variant="muted">{count}</Badge></h2>
      <Card><CardContent className="overflow-x-auto p-0">{children}</CardContent></Card>
    </section>
  );
}
