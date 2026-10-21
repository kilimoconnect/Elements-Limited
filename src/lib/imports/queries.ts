import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

const N = (v: unknown) => Number(v ?? 0);

export interface ShipmentSummary {
  id: string; document_number: string | null; supplier: string; bill_of_lading: string | null; incoterm: string; named_place: string | null;
  currency_code: string; logistics_status: string; cost_status: string; eta: string | null; shipped_date: string | null;
  expected_kg: number; received_kg: number; in_transit_kg: number;
  awaiting_invoice: number;       // accrued costs without their actual invoice
  unallocated: number;            // capitalised costs not fully allocated to stock / transit
  goods_uninvoiced: boolean;
}

/** Shipment list with progress and open-item counts. */
export async function shipmentSummaries(companyId: string): Promise<ShipmentSummary[]> {
  const admin = createAdminClient();
  const [{ data: ships }, { data: lines }, { data: sources }] = await Promise.all([
    admin.from("import_shipments").select("id, document_number, bill_of_lading, incoterm, named_place, currency_code, logistics_status, cost_status, eta, shipped_date, supplier:suppliers(name)")
      .eq("company_id", companyId).order("created_at", { ascending: false }).limit(200),
    admin.from("import_shipment_lines").select("shipment_id, net_kg, shipped_kg, received_kg, short_normal_kg, short_writeoff_kg, short_claim_kg, line_closed, quantity, goods_invoiced_qty")
      .eq("company_id", companyId),
    admin.from("cost_sources").select("import_shipment_id, status, inventory_treatment, accrued_amount, actual_amount, capitalised_applied")
      .eq("company_id", companyId).eq("owner_type", "import_shipment").neq("status", "voided"),
  ]);
  return ((ships ?? []) as unknown as Array<Record<string, unknown>>).map((s) => {
    const ls = (lines ?? []).filter((l) => l.shipment_id === s.id);
    const expected = ls.reduce((a, l) => a + N(l.shipped_kg ?? l.net_kg), 0);
    const received = ls.reduce((a, l) => a + N(l.received_kg), 0);
    const transit = ls.reduce((a, l) => a + (l.line_closed ? 0 : Math.max(N(l.shipped_kg ?? l.net_kg) - N(l.received_kg) - N(l.short_normal_kg) - N(l.short_writeoff_kg) - N(l.short_claim_kg), 0)), 0);
    const srcs = (sources ?? []).filter((c) => c.import_shipment_id === s.id);
    return {
      id: s.id as string, document_number: s.document_number as string | null, supplier: (s.supplier as { name: string } | null)?.name ?? "—",
      bill_of_lading: s.bill_of_lading as string | null, incoterm: s.incoterm as string, named_place: s.named_place as string | null,
      currency_code: s.currency_code as string, logistics_status: s.logistics_status as string, cost_status: s.cost_status as string,
      eta: s.eta as string | null, shipped_date: s.shipped_date as string | null,
      expected_kg: expected, received_kg: received, in_transit_kg: transit,
      awaiting_invoice: srcs.filter((c) => c.status === "accrued").length,
      unallocated: srcs.filter((c) => c.inventory_treatment === "capitalize"
        && N(c.capitalised_applied) !== (c.status === "invoiced" ? N(c.actual_amount) : c.status === "accrued" ? N(c.accrued_amount) : 0)).length,
      goods_uninvoiced: ls.some((l) => N(l.goods_invoiced_qty) + 0.0001 < N(l.quantity)),
    };
  });
}

export const LOGISTICS_LABEL: Record<string, string> = {
  draft: "Draft", ready: "Ready", dispatched: "Dispatched", partially_received: "Partially received",
  received: "Received", closed: "Closed", cancelled: "Cancelled",
};
export const COST_LABEL: Record<string, string> = {
  estimated: "Estimated", provisional: "Provisional", finalized: "Finalised", adjusted: "Adjusted",
};
