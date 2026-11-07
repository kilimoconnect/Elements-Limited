import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";

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

/** Request-to-delivery history with the named user and Dar es Salaam time. */
export function Timeline({ items, label, nameOf, shipmentNo }: {
  items: { id: string; event_type: string; note: string | null; user_id: string | null; created_at: string; shipment_id: string | null }[];
  label: Record<string, string>; nameOf: (id: string | null) => string; shipmentNo?: (id: string | null) => string | null;
}) {
  if (!items.length) return null;
  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <p className="mb-3 text-sm font-medium">Timeline</p>
        <ol className="space-y-3 border-l border-border pl-4">
          {items.map((e) => {
            const truck = shipmentNo?.(e.shipment_id);
            return (
              <li key={e.id} className="relative text-sm">
                <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
                <p className="font-medium">{label[e.event_type] ?? e.event_type}{truck ? <span className="font-normal text-muted-foreground"> · {truck}</span> : null}</p>
                {e.note && <p className="text-muted-foreground">{readable(e.note)}</p>}
                <p className="text-xs text-muted-foreground">{nameOf(e.user_id)} · {formatDateTime(e.created_at)}</p>
              </li>
            );
          })}
        </ol>
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
