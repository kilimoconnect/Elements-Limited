import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePeriod, type SP } from "@/lib/reports/period";
import { transferReport, TRUCK_STATUS, type Agg, type TruckStatus } from "@/lib/reports/transfer-report";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClickableRow } from "@/components/common/clickable-row";
import { PeriodFilter, PrintButton, ExportCsvButton, ParamSelect } from "@/components/reports/report-tools";
import { formatDate, formatDateTime, formatQuantity, csvDate, csvTime } from "@/lib/format";

export const metadata: Metadata = { title: "Transfer Report" };
const s = (sp: SP, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const hrs = (h: number | null) => (h == null ? "—" : h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} h`);
const q = (v: number) => (Math.abs(v) < 1e-9 ? "—" : formatQuantity(v));

export default async function TransferReportPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("inventory.transfer_view");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const { start, end } = resolvePeriod(sp);
  const filters = { start, end, from: s(sp, "from"), to: s(sp, "to"), product: s(sp, "product"), status: s(sp, "status") };
  const admin = createAdminClient();
  const [r, { data: branches }, { data: products }] = await Promise.all([
    transferReport(ctx.companyId, ctx.user.isOwner ? null : ctx.user.branchIds, filters),
    admin.from("branches").select("id, name").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("products").select("id, sku, name").eq("company_id", ctx.companyId).eq("is_active", true).order("sku"),
  ]);
  const t = r.totals;
  const bOpts = (branches ?? []).map((b) => ({ id: b.id, label: b.name }));
  const filterText = [
    `${formatDate(start)} – ${formatDate(end)}`,
    filters.from && `from ${bOpts.find((b) => b.id === filters.from)?.label}`,
    filters.to && `to ${bOpts.find((b) => b.id === filters.to)?.label}`,
    filters.product && (products ?? []).find((p) => p.id === filters.product)?.sku,
    filters.status && TRUCK_STATUS[filters.status as TruckStatus],
  ].filter(Boolean).join(" · ");

  return (
    <div className="space-y-5">
      <PageHeader title="Transfer Report"
        description="Stock moved between branches, truck by truck: what was loaded, what arrived, what is still on the road, and how long the trips took."
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename={`transfer-report-${start}-${end}.csv`}
          header={["Transfer", "Trip / DN", "Delivery note", "From", "To", "Truck", "Trailer", "Driver", "Driver phone", "Order created date", "Order created time", "Dispatch date", "Dispatch time", "Expected arrival date", "Expected arrival time", "Arrival date", "Arrival time", "Status", "Late",
            "Transit hours", "SKU", "Product", "Unit", "Loaded", "Received", "In transit", "Short", "Damaged", "Lost"]}
          rows={r.trucks.flatMap((x) => (x.lines.length ? x.lines : [null]).map((l) => [x.transfer, x.trip, x.deliveryNote ?? "", x.from, x.to, x.vehicle ?? "", x.trailer ?? "", x.driver ?? "", x.driverPhone ?? "",
            csvDate(x.orderCreated), csvTime(x.orderCreated), csvDate(x.dispatchedAt), csvTime(x.dispatchedAt), csvDate(x.eta), csvTime(x.eta), csvDate(x.arrivedAt), csvTime(x.arrivedAt), TRUCK_STATUS[x.status], x.late ? "yes" : "", x.transitHours == null ? "" : x.transitHours.toFixed(1),
            l?.sku ?? "", l?.product ?? "", l?.unit ?? "", l?.loaded ?? 0, l?.received ?? 0, l?.inTransit ?? 0, l?.short ?? 0, l?.damaged ?? 0, l?.lost ?? 0]))} /></div>}
      />

      <div className="flex flex-wrap items-end gap-2 print-hide">
        <PeriodFilter start={start} end={end} />
        <ParamSelect param="from" value={filters.from} placeholder="All sending branches" options={bOpts} />
        <ParamSelect param="to" value={filters.to} placeholder="All receiving branches" options={bOpts} />
        <ParamSelect param="product" value={filters.product} placeholder="All products" options={(products ?? []).map((p) => ({ id: p.id, label: `${p.sku} — ${p.name}` }))} />
        <ParamSelect param="status" value={filters.status} placeholder="Any status" options={Object.entries(TRUCK_STATUS).map(([id, label]) => ({ id, label }))} />
        {(filters.from || filters.to || filters.product || filters.status) && <Link href={`/reports/transfers?start=${start}&end=${end}`} className="text-sm text-primary underline">Clear filters</Link>}
      </div>
      <p className="text-sm text-muted-foreground">Showing {filterText}. A truck counts in the period by its dispatch date; a truck still waiting for loading counts by the date its order was created.</p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Transfer orders" value={String(r.orders)} note={`${r.loadedTrucks} truck(s) loaded · ${r.waiting} waiting for loading`} />
        <Kpi label="Quantity loaded" value={formatQuantity(t.loaded)} note={`${formatQuantity(t.received)} received in good condition`} />
        <Kpi label="Still in transit" value={formatQuantity(t.inTransit)} note={r.delayedNow ? `${r.delayedNow} truck(s) past their expected arrival` : "No truck overdue"} warn={r.delayedNow > 0} />
        <Kpi label="Short, damaged or lost" value={formatQuantity(t.short + t.damaged + t.lost)} note={`Short ${formatQuantity(t.short)} · damaged ${formatQuantity(t.damaged)} · lost ${formatQuantity(t.lost)}`} warn={t.short + t.damaged + t.lost > 0} />
        <Kpi label="Arrived on time" value={pct(r.onTimeRate)} note={`${t.onTime} of ${t.timed} arrived trucks with an expected arrival`} />
        <Kpi label="Average transit time" value={hrs(r.avgTransitHours)} note="From loading confirmed to arrival" />
        <Kpi label="Received rate" value={t.loaded ? pct(t.received / t.loaded) : "—"} note="Received in good condition ÷ loaded" />
        <Kpi label="Loss rate" value={t.loaded ? pct((t.short + t.damaged + t.lost) / t.loaded) : "—"} note="Short + damaged + lost ÷ loaded" />
      </div>

      {r.trucks.length === 0 ? <EmptyState title="No transfers match these filters" description="Change the period or clear the filters to see past transfers." /> : (
        <>
          <Section title="By route" explain="Each sending → receiving branch pair. Shows how much moved on each route, how much arrived, and how reliable the route is (on-time share and average time on the road).">
            <AggTable rows={r.byRoute} first="Route" />
          </Section>
          <Section title="By product" explain="Quantities per product across all loaded trucks in the period, in the product's own unit. Differences between loaded and received are explained by goods still in transit, short, damaged (quarantined) or lost.">
            <AggTable rows={r.byProduct} first="Product" unit />
          </Section>
          <Section title="Truck register" explain="Every truck in the period with its documents, crew, timing and cargo. Late means it arrived after, or is still on the road past, the expected arrival the store keeper entered. Click a row to open the transfer.">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Transfer / trip</TableHead><TableHead>Route</TableHead><TableHead>Truck · driver</TableHead><TableHead>Dispatched · expected · arrived</TableHead>
                <TableHead>Cargo</TableHead><TableHead className="text-right">Loaded</TableHead><TableHead className="text-right">Received</TableHead><TableHead className="text-right">In transit</TableHead>
                <TableHead className="text-right">Short / damaged / lost</TableHead><TableHead>Status</TableHead>
              </TableRow></TableHeader>
              <TableBody>{r.trucks.map((x) => (
                <ClickableRow key={x.tripId} href={`/inventory/transfers/${x.transferId}`}>
                  <TableCell className="text-xs"><span className="font-mono font-medium">{x.transfer}</span><span className="block text-muted-foreground">{x.trip}{x.deliveryNote ? ` · DN ${x.deliveryNote}` : ""}</span></TableCell>
                  <TableCell className="text-sm">{x.from}<span className="block text-muted-foreground">→ {x.to}</span></TableCell>
                  <TableCell className="text-xs"><span className="font-medium">{x.vehicle ?? "—"}</span>{x.trailer && ` / ${x.trailer}`}<span className="block text-muted-foreground">{x.driver ?? "—"}{x.driverPhone ? ` · ${x.driverPhone}` : ""}</span></TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {x.dispatchedAt ? formatDateTime(x.dispatchedAt) : `Order ${formatDateTime(x.orderCreated)}`}
                    <span className="block text-muted-foreground">ETA {x.eta ? formatDateTime(x.eta) : "—"}</span>
                    <span className="block text-muted-foreground">Arrived {x.arrivedAt ? formatDateTime(x.arrivedAt) : "—"}{x.transitHours != null ? ` (${hrs(x.transitHours)})` : ""}</span>
                  </TableCell>
                  <TableCell className="text-xs">{x.lines.map((l, i) => <span key={i} className="block">{l.sku} {l.product}</span>)}</TableCell>
                  <TableCell className="text-right tabular-nums">{q(x.loaded)}</TableCell>
                  <TableCell className="text-right tabular-nums">{q(x.received)}</TableCell>
                  <TableCell className="text-right tabular-nums">{q(x.inTransit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{q(x.short)} / {q(x.damaged)} / {q(x.lost)}</TableCell>
                  <TableCell><Badge variant={x.status === "received" ? "success" : x.status === "waiting" ? "warning" : "default"}>{TRUCK_STATUS[x.status]}</Badge>
                    {x.late && <Badge variant="destructive" className="ml-1">late</Badge>}</TableCell>
                </ClickableRow>
              ))}
                <TableRow className="border-t-2 bg-muted/40 font-semibold hover:bg-muted/40">
                  <TableCell colSpan={5}>Total ({r.trucks.length} truck{r.trucks.length === 1 ? "" : "s"})</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(t.loaded)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(t.received)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(t.inTransit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(t.short)} / {formatQuantity(t.damaged)} / {formatQuantity(t.lost)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </Section>
        </>
      )}

      <Card className="p-4 text-xs text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">How to read this report</p>
        <p><b>Loaded</b>: quantity on trucks the store keeper confirmed as loaded. <b>Received</b>: accepted in good condition by the receiving branch.
          <b> In transit</b>: loaded but not yet reported at the destination. <b>Short</b>: missing on arrival; <b>damaged</b>: held in quarantine; <b>lost</b>: written off.
          <b> Arrived on time</b> compares the arrival with the expected arrival entered at loading. Quantities are in each product&apos;s unit (usually bags); values and charges are in the Transfer Costing report.</p>
      </Card>
    </div>
  );
}

function Kpi({ label, value, note, warn }: { label: string; value: string; note: string; warn?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${warn ? "text-destructive" : ""}`}>{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
    </Card>
  );
}

function Section({ title, explain, children }: { title: string; explain: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div><h2 className="text-base font-semibold">{title}</h2><p className="text-xs text-muted-foreground">{explain}</p></div>
      <Card className="overflow-x-auto">{children}</Card>
    </section>
  );
}

function AggTable({ rows, first, unit }: { rows: Agg[]; first: string; unit?: boolean }) {
  return (
    <Table>
      <TableHeader><TableRow>
        <TableHead>{first}</TableHead>{unit && <TableHead>Unit</TableHead>}<TableHead className="text-right">Trucks</TableHead><TableHead className="text-right">Loaded</TableHead>
        <TableHead className="text-right">Received</TableHead><TableHead className="text-right">In transit</TableHead><TableHead className="text-right">Short</TableHead>
        <TableHead className="text-right">Damaged</TableHead><TableHead className="text-right">Lost</TableHead><TableHead className="text-right">On time</TableHead><TableHead className="text-right">Avg transit</TableHead>
      </TableRow></TableHeader>
      <TableBody>{rows.map((a) => (
        <TableRow key={a.key}>
          <TableCell className="text-sm font-medium">{a.label}</TableCell>{unit && <TableCell className="text-xs">{a.unit}</TableCell>}
          <TableCell className="text-right tabular-nums">{a.trucks}</TableCell>
          <TableCell className="text-right tabular-nums">{formatQuantity(a.loaded)}</TableCell>
          <TableCell className="text-right tabular-nums">{formatQuantity(a.received)}</TableCell>
          <TableCell className="text-right tabular-nums">{q(a.inTransit)}</TableCell>
          <TableCell className="text-right tabular-nums">{q(a.short)}</TableCell>
          <TableCell className="text-right tabular-nums">{q(a.damaged)}</TableCell>
          <TableCell className="text-right tabular-nums">{q(a.lost)}</TableCell>
          <TableCell className="text-right tabular-nums">{a.timed ? pct(a.onTime / a.timed) : "—"}</TableCell>
          <TableCell className="text-right tabular-nums">{hrs(a.hoursN ? a.hours / a.hoursN : null)}</TableCell>
        </TableRow>
      ))}</TableBody>
    </Table>
  );
}
