import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { FullTimelineButton, TimelineList, type TimelineRow } from "@/components/sales/timeline-full";

type V = "muted" | "warning" | "destructive" | "success" | "default";

const AMENDMENT: Record<string, string> = {
  change_lines: "Change quantity / price", delivery: "Change delivery details", cancel_remaining: "Cancel the remaining balance", change_branch: "Change branch",
};
/** Timeline notes store amendment codes (e.g. change_branch); show their names instead. */
const readable = (note: string) => note.replace(/\b(change_lines|cancel_remaining|change_branch|delivery)\b(?=[:,]|$)/g, (k) => AMENDMENT[k] ?? k);

export function StatusBadge({ map, status }: { map: Record<string, { label: string; variant: V }>; status: string }) {
  const s = map[status] ?? { label: status, variant: "muted" as V };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

/** Request-to-delivery history with the named user and Dar es Salaam time.
 *  The page shows the latest few steps; the full history opens in its own window. */
export function Timeline({ items, label, nameOf, shipmentNo, recent = 3 }: {
  items: { id: string; event_type: string; note: string | null; user_id: string | null; created_at: string; shipment_id: string | null }[];
  label: Record<string, string>; nameOf: (id: string | null) => string; shipmentNo?: (id: string | null) => string | null; recent?: number;
}) {
  if (!items.length) return null;
  const rows: TimelineRow[] = items.map((e) => ({
    id: e.id, title: label[e.event_type] ?? e.event_type, truck: shipmentNo?.(e.shipment_id) ?? null,
    note: e.note ? readable(e.note) : null, meta: `${nameOf(e.user_id)} · ${formatDateTime(e.created_at)}`,
  }));
  const latest = rows.slice(-recent).reverse();
  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">Timeline{rows.length > recent ? <span className="font-normal text-muted-foreground"> · latest {recent} of {rows.length}</span> : null}</p>
          {rows.length > recent && <FullTimelineButton rows={rows} />}
        </div>
        <TimelineList rows={latest} />
      </CardContent>
    </Card>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="break-words text-sm">{children || "—"}</div>
    </div>
  );
}
