import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatDateTime, formatQuantity } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { NewTransferButton } from "./transfer-form";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { ExportCsvButton, ParamSelect } from "@/components/reports/report-tools";
import { Pager, PAGE_SIZE, pageOf, str } from "@/components/reports/pager";

export const metadata: Metadata = { title: "Stock Transfers" };
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const N = (v: unknown) => Number(v ?? 0);

export default async function TransfersPage(props: { searchParams: SearchParams }) {
  await requirePermissionPage("inventory.transfer_view");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const view = str(sp, "view"), branchF = str(sp, "branch"), page = pageOf(sp);
  const inTransit = view !== "all";
  const admin = createAdminClient();
  const canDispatch = can(ctx.user, "inventory.transfer_dispatch");
  const myBranches = ctx.user.isOwner ? ctx.branches.map((b) => b.id) : ctx.user.branchIds;
  const none = ["00000000-0000-0000-0000-000000000000"];

  const { data: products } = await admin.from("products")
    .select("id, sku, name").eq("company_id", ctx.companyId).eq("is_active", true).order("sku");

  // Sender and receiver see the same transfer; other branches see nothing (Stage 1 D3).
  let q = admin.from("stock_transfers")
    .select("id, document_number, transfer_date, status, reference, has_open_discrepancy, source_branch_id, destination_branch_id, source:branches!stock_transfers_source_branch_id_fkey(code), dest:branches!stock_transfers_destination_branch_id_fkey(code), lines:stock_transfer_lines(qty_requested, qty_dispatched, qty_received, qty_quarantined, qty_short_pending, qty_lost_normal, qty_lost_abnormal), trips:stock_transfer_dispatches(id, status, trip_no, document_number, driver_name, driver_phone, vehicle_registration, dispatched_at, expected_arrival_at), agents:stock_transfer_agents(name, phone, role), events:stock_transfer_events(event_type, note, created_at)")
    .eq("company_id", ctx.companyId)
    .or(`source_branch_id.in.(${(myBranches.length ? myBranches : none).join(",")}),destination_branch_id.in.(${(myBranches.length ? myBranches : none).join(",")})`)
    .order("created_at", { ascending: false }).limit(200);
  if (inTransit) q = q.in("status", ["dispatched", "partially_received", "received"]);
  const { data: rows } = await q;
  type Row = {
    id: string; document_number: string | null; transfer_date: string; status: string; reference: string | null; has_open_discrepancy: boolean;
    source_branch_id: string; destination_branch_id: string; source: { code: string } | null; dest: { code: string } | null;
    lines: { qty_requested: number; qty_dispatched: number; qty_received: number; qty_quarantined: number; qty_short_pending: number; qty_lost_normal: number; qty_lost_abnormal: number }[];
    trips: { id: string; status: string; trip_no: number; document_number: string | null; driver_name: string | null; driver_phone: string | null; vehicle_registration: string | null; dispatched_at: string | null; expected_arrival_at: string | null }[];
    events: { event_type: string; note: string | null; created_at: string }[];
    agents: { name: string; phone: string | null; role: string | null }[];
  };
  const filtered = ((rows ?? []) as unknown as Row[])
    .filter((r) => !inTransit || r.status !== "received" || r.has_open_discrepancy)
    .filter((r) => !branchF || r.source_branch_id === branchF || r.destination_branch_id === branchF);
  const list = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const now = new Date().toISOString();
  const overdueOf = (r: Row) => r.trips.some((t) => ["dispatched", "arrived"].includes(t.status) && t.expected_arrival_at && t.expected_arrival_at < now);
  // Document counts per transfer and per trip (opened from the detail page with the usual access checks).
  const ownerIds = filtered.flatMap((r) => [r.id, ...r.trips.map((t) => t.id)]);
  const { data: docs } = ownerIds.length ? await admin.from("document_attachments").select("owner_id").in("owner_id", ownerIds) : { data: [] };
  const docCount = (r: Row) => ((docs ?? []) as { owner_id: string }[]).filter((d) => d.owner_id === r.id || r.trips.some((t) => t.id === d.owner_id)).length;

  return (
    <div>
      <PageHeader
        title="Stock Transfers"
        description="One shared transfer for the sending and the receiving branch: trips, cargo, documents and receipt progress."
        actions={ctx.branchId && can(ctx.user, "inventory.transfer_create") && <NewTransferButton products={(products ?? []) as never} branches={ctx.branches} sourceBranchId={ctx.branchId} canDispatch={canDispatch} />}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/inventory/transfers" className={`rounded-md px-3 py-1.5 ${inTransit ? "bg-primary text-primary-foreground" : "border border-border"}`}>In transit / open</Link>
        <Link href="/inventory/transfers?view=all" className={`rounded-md px-3 py-1.5 ${!inTransit ? "bg-primary text-primary-foreground" : "border border-border"}`}>All transfers</Link>
        <ParamSelect param="branch" value={branchF} placeholder="All my branches" options={ctx.branches.filter((b) => myBranches.includes(b.id)).map((b) => ({ id: b.id, label: `${b.code} — ${b.name}` }))} />
        <span className="ml-auto"><ExportCsvButton filename="in-transit.csv"
          header={["Transfer", "From", "To", "Status", "Trip", "Driver", "Driver phone", "Vehicle", "Agents", "Dispatched", "ETA", "Overdue", "Dispatched qty", "Received qty"]}
          rows={filtered.flatMap((r) => (r.trips.length ? r.trips : [null]).map((t) => [r.document_number ?? "draft", r.source?.code ?? "", r.dest?.code ?? "", r.status,
            t?.document_number ?? "", t?.driver_name ?? "", t?.driver_phone ?? "", t?.vehicle_registration ?? "", r.agents.map((a) => `${a.name}${a.role ? ` (${a.role})` : ""}${a.phone ? ` ${a.phone}` : ""}`).join("; "),
            t?.dispatched_at ?? "", t?.expected_arrival_at ?? "", overdueOf(r) ? "yes" : "",
            r.lines.reduce((a, l) => a + N(l.qty_dispatched), 0), r.lines.reduce((a, l) => a + N(l.qty_received), 0)]))} /></span>
      </div>
      {list.length === 0 ? (
        <EmptyState title={inTransit ? "Nothing in transit for your branches" : "No transfers yet"} />
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Transfer</TableHead><TableHead>From → To</TableHead><TableHead>Trips / driver / vehicle / agents</TableHead>
                <TableHead>Departure · ETA</TableHead><TableHead className="text-right">Dispatched</TableHead><TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Outstanding</TableHead><TableHead>Status</TableHead><TableHead>Latest update</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => {
                const disp = r.lines.reduce((a, l) => a + N(l.qty_dispatched), 0);
                const recv = r.lines.reduce((a, l) => a + N(l.qty_received), 0);
                const lost = r.lines.reduce((a, l) => a + N(l.qty_lost_normal) + N(l.qty_lost_abnormal), 0);
                const held = r.lines.reduce((a, l) => a + N(l.qty_quarantined) + N(l.qty_short_pending), 0);
                const live = r.trips.filter((t) => !["voided"].includes(t.status)).sort((a, b) => a.trip_no - b.trip_no);
                const last = [...r.events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
                const role = myBranches.includes(r.source_branch_id) && myBranches.includes(r.destination_branch_id) ? "" : myBranches.includes(r.source_branch_id) ? "sending" : "receiving";
                return (
                  <TableRow key={r.id}>
                    <TableCell><Link href={`/inventory/transfers/${r.id}`} className="font-mono text-xs underline">{r.document_number ?? "draft"}</Link>
                      <p className="text-xs text-muted-foreground">{formatDate(r.transfer_date)}{role && ` · you are ${role}`}</p></TableCell>
                    <TableCell className="text-sm">{r.source?.code} → {r.dest?.code}</TableCell>
                    <TableCell className="text-xs">{live.length === 0 ? "—" : live.map((t) => (
                      <p key={t.id}>{t.document_number ?? `Trip ${t.trip_no} (draft)`} · {t.driver_name ?? "—"}{t.driver_phone ? ` ${t.driver_phone}` : ""} · {t.vehicle_registration ?? "—"}</p>
                    ))}{r.agents.map((a, i) => <p key={i} className="text-muted-foreground">Agent {a.name}{a.role && ` (${a.role})`}{a.phone && ` ${a.phone}`}</p>)}</TableCell>
                    <TableCell className="text-xs">{overdueOf(r) && <Badge variant="destructive" className="mb-1">overdue</Badge>}{live.map((t) => <p key={t.id}>{t.dispatched_at ? formatDateTime(t.dispatched_at) : "—"} · {t.expected_arrival_at ? formatDateTime(t.expected_arrival_at) : "—"}</p>)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(disp)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(recv)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(Math.max(disp - recv - lost - held, 0))}{held > 0 && <p className="text-xs text-warning">{formatQuantity(held)} held</p>}</TableCell>
                    <TableCell><DocStatusBadge status={r.status} />{r.has_open_discrepancy && <Badge variant="warning" className="ml-1">discrepancy</Badge>}<p className="text-xs text-muted-foreground">{docCount(r)} document(s)</p></TableCell>
                    <TableCell className="max-w-56 text-xs text-muted-foreground">{last ? <>{formatDateTime(last.created_at)} · {last.note ?? last.event_type}</> : "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
      <Pager basePath="/inventory/transfers" params={{ view, branch: branchF }} page={page} pageSize={PAGE_SIZE} total={filtered.length} />
      <p className="mt-3 text-xs text-muted-foreground">Licence numbers, licence images and costs are never included in this list or its export. Positions are as recorded by the branches (dispatch, updates, arrival); there is no live GPS tracking.</p>
    </div>
  );
}
