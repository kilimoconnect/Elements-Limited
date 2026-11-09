"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { checkRecentTruckUse } from "@/lib/transfers/actions";
import type { RecentMatch } from "@/lib/transfers/registration";
import { normaliseRegistration } from "@/lib/transfers/registration";
import { formatDate } from "@/lib/format";

/**
 * Advisory only: shows stock transfers of the last three days that used the
 * same truck or trailer (formatting ignored). Nothing is blocked.
 */
export function RecentTruckWarning({ vehicle, trailer, excludeTransferId, excludeTripId }: {
  vehicle: string; trailer?: string; excludeTransferId?: string; excludeTripId?: string;
}) {
  const [matches, setMatches] = React.useState<RecentMatch[]>([]);
  const key = `${normaliseRegistration(vehicle)}|${normaliseRegistration(trailer)}`;
  React.useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      if (key === "|") { if (live) setMatches([]); return; }
      const r = await checkRecentTruckUse({ vehicle, trailer, excludeTransferId, excludeTripId });
      if (live) setMatches(r.ok ? r.matches : []);
    }, 450);
    return () => { live = false; clearTimeout(t); };
    // Re-check only when the normalised registrations change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, excludeTransferId, excludeTripId]);
  if (!matches.length) return null;
  return (
    <div className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm sm:col-span-3" role="status">
      <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" /> This truck was used on a stock transfer in the last 3 days</p>
      <ul className="mt-1 space-y-1">
        {matches.map((m, i) => (
          <li key={`${m.transferId}-${m.tripNo ?? 0}-${i}`}>
            <Link className="font-medium text-primary hover:underline" href={`/inventory/transfers/${m.transferId}`} target="_blank">
              {m.transferNumber ?? "Draft transfer"}{m.tripNo ? ` · trip ${m.tripNo}` : ""}
            </Link>
            <span className="text-muted-foreground"> · {formatDate(m.date)} · {m.status.replace(/_/g, " ")}</span>
            {m.reasons.map((r) => <span key={r} className="block text-xs text-muted-foreground">{r}.</span>)}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">Registrations are compared ignoring spaces, dots, dashes and capitals. Check this is intended; you can continue.</p>
    </div>
  );
}
