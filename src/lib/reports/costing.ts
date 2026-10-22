import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { localDayEnd, localDayStart } from "@/lib/format";

/*
 * Read-only queries for the Stage 8 costing and operations reports. Every
 * query is scoped to the active company; branch scoping is applied by the
 * callers from the user's branches. Figures come from posted documents and
 * the cost versions already recorded (cost sources, allocations, deltas).
 */
const N = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
type Admin = ReturnType<typeof createAdminClient>;

/* ------------------------------ shipments ------------------------------- */
export interface ShipmentCostRow {
  id: string; number: string; supplier: string; incoterm: string; basis: string; currency: string; logistics: string; costing: string; eta: string | null;
  expectedKg: number; receivedKg: number;
  goodsEst: number; goodsAct: number; capEst: number; capAct: number; expensed: number;
  unallocated: number; accrualVariance: number; awaitingInvoice: number;
  estPerKg: number | null; actPerKg: number | null;
}
export async function shipmentCosting(companyId: string, from: string, to: string, status: string): Promise<ShipmentCostRow[]> {
  const admin = createAdminClient();
  let q = admin.from("import_shipments").select("id, document_number, incoterm, goods_includes_freight, goods_includes_insurance, currency_code, logistics_status, cost_status, eta, created_at, supplier:suppliers(name)")
    .eq("company_id", companyId).gte("created_at", localDayStart(from)).lte("created_at", localDayEnd(to)).order("created_at", { ascending: false });
  if (status) q = q.eq("cost_status", status);
  const { data: ships } = await q;
  const out: ShipmentCostRow[] = [];
  for (const s of (ships ?? []) as unknown as Array<Record<string, unknown>>) {
    const [{ data: sheet }, { data: srcs }] = await Promise.all([
      admin.rpc("landed_cost_sheet", { p_shipment: s.id }),
      admin.from("cost_sources").select("inventory_treatment, status, estimated_amount, accrued_amount, actual_amount, capitalised_applied, accrual_date")
        .eq("import_shipment_id", s.id as string).neq("status", "voided"),
    ]);
    const lines = (sheet ?? []) as Record<string, number>[];
    const cs = (srcs ?? []) as Record<string, unknown>[];
    const sum = (k: string) => lines.reduce((a, l) => a + N(l[k]), 0);
    const expKg = sum("expected_kg"), recKg = sum("received_kg");
    const posted = (c: Record<string, unknown>) => c.status === "invoiced" ? N(c.actual_amount) : c.status === "accrued" ? N(c.accrued_amount) : 0;
    const actTotal = sum("act_total"), estTotal = sum("est_total");
    const kgBase = recKg > 0 ? recKg : expKg;
    out.push({
      id: s.id as string, number: (s.document_number as string) ?? "—", supplier: (s.supplier as { name: string } | null)?.name ?? "—",
      incoterm: s.incoterm as string, basis: `${s.incoterm}${s.goods_includes_freight ? " (incl. freight" + (s.goods_includes_insurance ? " + insurance)" : ")") : ""}`,
      currency: s.currency_code as string, logistics: s.logistics_status as string, costing: s.cost_status as string, eta: s.eta as string | null,
      expectedKg: expKg, receivedKg: recKg,
      goodsEst: r2(sum("est_goods")), goodsAct: r2(sum("act_goods")), capEst: r2(sum("est_costs")), capAct: r2(sum("act_costs")),
      expensed: r2(cs.filter((c) => c.inventory_treatment === "expense").reduce((a, c) => a + posted(c), 0)),
      unallocated: r2(cs.filter((c) => c.inventory_treatment === "capitalize").reduce((a, c) => a + (posted(c) - N(c.capitalised_applied)), 0)),
      accrualVariance: r2(cs.filter((c) => c.status === "invoiced" && c.accrual_date).reduce((a, c) => a + N(c.actual_amount) - N(c.accrued_amount), 0)),
      awaitingInvoice: cs.filter((c) => c.status === "accrued").length,
      estPerKg: expKg > 0 ? r2(estTotal / expKg) : null, actPerKg: kgBase > 0 ? r2(actTotal / kgBase) : null,
    });
  }
  return out;
}

/* ------------------------------ rebagging ------------------------------- */
export interface RebagCostRow {
  id: string; number: string; date: string | null; branch: string; bulk: string; status: string; costing: string;
  issuedKg: number; packedKg: number; returnedKg: number; normalLossKg: number; abnormalLossKg: number;
  bulkValue: number; packagingValue: number; conversionValue: number; abnormalValue: number; outputValue: number; lateAdjustments: number;
  outputs: { sku: string; name: string; bags: number; netKg: number; value: number; perBag: number; perKg: number }[];
  materials: { name: string; qty: number; damaged: number; value: number }[];
}
export async function rebagCosting(companyId: string, branchIds: string[] | null, from: string, to: string): Promise<RebagCostRow[]> {
  const admin = createAdminClient();
  let q = admin.from("rebag_orders").select("id, document_number, completion_date, document_status, cost_status, issued_kg, returned_kg, normal_loss_kg, abnormal_loss_kg, issued_value, returned_value, abnormal_loss_value, packaging_value, conversion_value, output_value, branch:branches(code), bulk:products!rebag_orders_bulk_product_id_fkey(name), outputs:rebag_outputs(bags, net_kg, value_tzs, cost_delta_tzs, product:products(sku, name)), inputs:rebag_inputs(input_kind, quantity, damaged_qty, value_tzs, product:products(name))")
    .eq("company_id", companyId).eq("document_status", "completed").gte("completion_date", from).lte("completion_date", to).order("completion_date", { ascending: false });
  if (branchIds) q = q.in("branch_id", branchIds.length ? branchIds : ["00000000-0000-0000-0000-000000000000"]);
  const { data } = await q;
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((o) => {
    const outs = (o.outputs as { bags: number; net_kg: number; value_tzs: number; cost_delta_tzs: number; product: { sku: string; name: string } | null }[]);
    const ins = (o.inputs as { input_kind: string; quantity: number; damaged_qty: number; value_tzs: number; product: { name: string } | null }[]);
    return {
      id: o.id as string, number: (o.document_number as string) ?? "—", date: o.completion_date as string | null, branch: (o.branch as { code: string } | null)?.code ?? "—",
      bulk: (o.bulk as { name: string } | null)?.name ?? "—", status: o.document_status as string, costing: o.cost_status as string,
      issuedKg: N(o.issued_kg), packedKg: outs.reduce((a, x) => a + N(x.net_kg), 0), returnedKg: N(o.returned_kg), normalLossKg: N(o.normal_loss_kg), abnormalLossKg: N(o.abnormal_loss_kg),
      bulkValue: r2(N(o.issued_value) - N(o.returned_value) - N(o.abnormal_loss_value)), packagingValue: N(o.packaging_value), conversionValue: N(o.conversion_value),
      abnormalValue: N(o.abnormal_loss_value), outputValue: N(o.output_value), lateAdjustments: r2(outs.reduce((a, x) => a + N(x.cost_delta_tzs), 0)),
      outputs: outs.map((x) => {
        const v = N(x.value_tzs) + N(x.cost_delta_tzs);
        return { sku: x.product?.sku ?? "", name: x.product?.name ?? "", bags: N(x.bags), netKg: N(x.net_kg), value: r2(v), perBag: N(x.bags) ? r2(v / N(x.bags)) : 0, perKg: N(x.net_kg) ? r2(v / N(x.net_kg)) : 0 };
      }),
      materials: ins.filter((x) => x.input_kind === "packaging").map((x) => ({ name: x.product?.name ?? "", qty: N(x.quantity), damaged: N(x.damaged_qty), value: N(x.value_tzs) })),
    };
  });
}

/* --------------------------- branch landed cost ------------------------- */
export interface BranchCostRow {
  branchId: string; branch: string; productId: string; sku: string; name: string; role: string; kgPerUnit: number | null;
  qty: number; value: number; avgCost: number; perKg: number | null; lastIncomingUnit: number | null; lastIncomingDate: string | null;
  sellingPrice: number;
}
export async function branchLandedCost(companyId: string, branchIds: string[] | null): Promise<BranchCostRow[]> {
  const admin = createAdminClient();
  let q = admin.from("stock_balances").select("branch_id, product_id, quantity, stock_value, avg_unit_cost, branch:branches(code), product:products(sku, name, stock_role, net_weight_kg, selling_price, base_unit_id)")
    .eq("company_id", companyId).gt("quantity", 0);
  if (branchIds) q = q.in("branch_id", branchIds.length ? branchIds : ["00000000-0000-0000-0000-000000000000"]);
  const [{ data: bal }, { data: units }, { data: incoming }] = await Promise.all([
    q,
    admin.from("units").select("id, kg_factor").eq("company_id", companyId),
    admin.from("stock_movements").select("branch_id, product_id, unit_cost, created_at").eq("company_id", companyId).eq("movement_type", "transfer_in").order("created_at", { ascending: false }).limit(2000),
  ]);
  const kgf = new Map(((units ?? []) as { id: string; kg_factor: number | null }[]).map((u) => [u.id, u.kg_factor == null ? null : N(u.kg_factor)]));
  const lastIn = new Map<string, { unit: number; date: string }>();
  for (const m of (incoming ?? []) as { branch_id: string; product_id: string; unit_cost: number; created_at: string }[]) {
    const k = `${m.branch_id}:${m.product_id}`;
    if (!lastIn.has(k)) lastIn.set(k, { unit: N(m.unit_cost), date: m.created_at });
  }
  return ((bal ?? []) as unknown as Array<Record<string, unknown>>).map((b) => {
    const p = b.product as { sku: string; name: string; stock_role: string; net_weight_kg: number | null; selling_price: number; base_unit_id: string | null };
    const kgu = p.stock_role === "bulk" ? 1 : p.net_weight_kg ? N(p.net_weight_kg) : (p.base_unit_id ? kgf.get(p.base_unit_id) ?? null : null);
    const k = `${b.branch_id}:${b.product_id}`;
    const avg = N(b.avg_unit_cost);
    const li = lastIn.get(k);
    return {
      branchId: b.branch_id as string, branch: (b.branch as { code: string } | null)?.code ?? "—", productId: b.product_id as string, sku: p.sku, name: p.name, role: p.stock_role,
      kgPerUnit: kgu, qty: N(b.quantity), value: N(b.stock_value), avgCost: avg, perKg: kgu ? r2(avg / kgu) : null,
      lastIncomingUnit: li ? li.unit : null, lastIncomingDate: li ? li.date : null,
      sellingPrice: N(p.selling_price),
    };
  });
}

/* ---------------------------- transfer costing -------------------------- */
export interface TransferCostRow {
  id: string; number: string; date: string; from: string; to: string; status: string; costing: string; product: string; sku: string;
  dispatched: number; received: number; sourceValue: number; loading: number; transport: number; offloading: number; other: number;
  chargesApplied: number; receivedValue: number; inTransitValue: number; lostValue: number; incomingUnit: number | null; destAvgAfter: number | null;
}
export async function transferCosting(companyId: string, branchIds: string[] | null, from: string, to: string): Promise<TransferCostRow[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("stock_transfers")
    .select("id, document_number, transfer_date, status, cost_status, posts_in_transit, source_branch_id, destination_branch_id, src:branches!stock_transfers_source_branch_id_fkey(code), dst:branches!stock_transfers_destination_branch_id_fkey(code), lines:stock_transfer_lines(id, product_id, qty_dispatched, qty_received, dispatched_value, received_value, transit_value, lost_value, charges_applied, product:products(sku, name))")
    .eq("company_id", companyId).eq("posts_in_transit", true).neq("status", "draft").gte("transfer_date", from).lte("transfer_date", to).order("transfer_date", { ascending: false });
  const ts = ((data ?? []) as unknown as Array<Record<string, unknown>>)
    .filter((t) => !branchIds || branchIds.includes(t.source_branch_id as string) || branchIds.includes(t.destination_branch_id as string));
  const ids = ts.map((t) => t.id as string);
  const [{ data: charges }, { data: moves }] = await Promise.all([
    ids.length ? admin.from("cost_sources").select("stock_transfer_id, status, inventory_treatment, estimated_amount, accrued_amount, actual_amount, description, category:cost_categories(code)").in("stock_transfer_id", ids).neq("status", "voided") : Promise.resolve({ data: [] }),
    ids.length ? admin.from("stock_movements").select("source_id, product_id, avg_cost_after, created_at").in("source_id", ids).eq("movement_type", "transfer_in").order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
  ]);
  const out: TransferCostRow[] = [];
  for (const t of ts) {
    const cs = ((charges ?? []) as unknown as { stock_transfer_id: string; status: string; inventory_treatment: string; estimated_amount: number; accrued_amount: number; actual_amount: number; description: string | null; category: { code: string } | null }[])
      .filter((c) => c.stock_transfer_id === t.id && c.inventory_treatment === "capitalize");
    const amt = (c: (typeof cs)[number]) => c.status === "invoiced" ? N(c.actual_amount) : c.status === "accrued" ? N(c.accrued_amount) : 0;
    const kind = (c: (typeof cs)[number]) => { const dsc = (c.description ?? "").toLowerCase();
      return dsc.includes("offload") ? "offloading" : c.category?.code === "TRANSPORT" || c.category?.code === "INLAND" ? "transport" : c.category?.code === "LOADING" ? "loading" : "other"; };
    const lines = t.lines as { id: string; product_id: string; qty_dispatched: number; qty_received: number; dispatched_value: number; received_value: number; transit_value: number; lost_value: number; charges_applied: number; product: { sku: string; name: string } | null }[];
    const totalDisp = lines.reduce((a, l) => a + N(l.dispatched_value), 0);
    for (const l of lines) {
      const share = totalDisp > 0 ? N(l.dispatched_value) / totalDisp : 0;
      const by = (k: string) => r2(cs.filter((c) => kind(c) === k).reduce((a, c) => a + amt(c), 0) * share);
      const mv = ((moves ?? []) as { source_id: string; product_id: string; avg_cost_after: number }[]).find((m) => m.source_id === t.id && m.product_id === l.product_id);
      out.push({
        id: t.id as string, number: (t.document_number as string) ?? "—", date: t.transfer_date as string, from: (t.src as { code: string } | null)?.code ?? "—",
        to: (t.dst as { code: string } | null)?.code ?? "—", status: t.status as string, costing: t.cost_status as string, product: l.product?.name ?? "", sku: l.product?.sku ?? "",
        dispatched: N(l.qty_dispatched), received: N(l.qty_received), sourceValue: N(l.dispatched_value),
        loading: by("loading"), transport: by("transport"), offloading: by("offloading"), other: by("other"), chargesApplied: N(l.charges_applied),
        receivedValue: N(l.received_value), inTransitValue: N(l.transit_value), lostValue: N(l.lost_value),
        incomingUnit: N(l.qty_received) > 0 ? r2(N(l.received_value) / N(l.qty_received)) : null, destAvgAfter: mv ? N(mv.avg_cost_after) : null,
      });
    }
  }
  return out;
}

/* ------------------------------ exceptions ------------------------------ */
export interface ExceptionRow { kind: string; severity: "high" | "medium"; document: string; href: string | null; detail: string; since: string | null }
export async function exceptions(admin: Admin, companyId: string, branchIds: string[] | null, today: string, accrualDays = 30): Promise<ExceptionRow[]> {
  const inBranch = (b: string | null | undefined) => !branchIds || (b != null && branchIds.includes(b));
  const out: ExceptionRow[] = [];
  const [ships, rebags, transfers, trips, srcs, recon, quarantine, versions, atts] = await Promise.all([
    admin.from("import_shipments").select("id, document_number, branch_id, logistics_status, cost_status, eta, bill_of_lading").eq("company_id", companyId).not("logistics_status", "in", "(draft,cancelled)"),
    admin.from("rebag_orders").select("id, document_number, branch_id, document_status, cost_status, issue_date").eq("company_id", companyId).in("document_status", ["issued", "completed"]),
    admin.from("stock_transfers").select("id, document_number, source_branch_id, destination_branch_id, status, cost_status, has_open_discrepancy").eq("company_id", companyId).eq("posts_in_transit", true).neq("status", "draft").neq("status", "voided"),
    admin.from("stock_transfer_dispatches").select("id, transfer_id, document_number, status, expected_arrival_at, dispatched_at, transfer:stock_transfers!inner(source_branch_id, destination_branch_id)").eq("company_id", companyId).in("status", ["dispatched", "arrived", "received"]),
    admin.from("cost_sources").select("id, owner_type, import_shipment_id, stock_transfer_id, rebag_order_id, purchase_id, status, inventory_treatment, accrued_amount, actual_amount, capitalised_applied, accrual_date, description").eq("company_id", companyId).neq("status", "voided"),
    admin.rpc("cost_reconciliation_checks", { p_company: companyId }),
    admin.from("stock_transfer_lines").select("transfer_id, qty_quarantined, qty_short_pending, product:products(name)").eq("company_id", companyId).or("qty_quarantined.gt.0,qty_short_pending.gt.0"),
    admin.from("document_versions").select("owner_id").eq("company_id", companyId).eq("owner_type", "stock_transfer_dispatch").eq("kind", "delivery_note"),
    admin.from("document_attachments").select("owner_type, owner_id, category").eq("company_id", companyId).in("category", ["bill_of_lading", "cargo_papers", "signed_delivery_note", "proof_of_delivery"]),
  ]);
  const has = (ownerId: string, cats: string[]) => ((atts.data ?? []) as { owner_id: string; category: string }[]).some((a) => a.owner_id === ownerId && cats.includes(a.category));
  for (const s of (ships.data ?? []) as Record<string, string | null>[]) {
    if (!inBranch(s.branch_id)) continue;
    const doc = s.document_number ?? "shipment", href = `/imports/${s.id}`;
    if (["received", "closed"].includes(s.logistics_status!) && !["finalized", "adjusted"].includes(s.cost_status!)) out.push({ kind: "Unfinalised costs", severity: "medium", document: doc, href, detail: `Received; costing ${s.cost_status}`, since: null });
    if (s.eta && s.eta < today && ["ready", "dispatched", "partially_received"].includes(s.logistics_status!)) out.push({ kind: "Overdue arrival", severity: "high", document: doc, href, detail: `ETA ${s.eta}, status ${s.logistics_status}`, since: s.eta });
    if (!s.bill_of_lading && !has(s.id!, ["bill_of_lading"])) out.push({ kind: "Missing documents", severity: "medium", document: doc, href, detail: "No bill of lading number or document", since: null });
  }
  for (const o of (rebags.data ?? []) as Record<string, string | null>[]) {
    if (!inBranch(o.branch_id)) continue;
    if (o.document_status === "completed" && o.cost_status === "provisional") out.push({ kind: "Unfinalised costs", severity: "medium", document: o.document_number ?? "rebag", href: `/inventory/rebagging/${o.id}`, detail: "Conversion charges awaiting invoice", since: null });
    if (o.document_status === "issued" && o.issue_date && o.issue_date < today) out.push({ kind: "Production open", severity: "medium", document: o.document_number ?? "rebag", href: `/inventory/rebagging/${o.id}`, detail: `Bulk issued ${o.issue_date}, not completed`, since: o.issue_date });
  }
  for (const t of (transfers.data ?? []) as Record<string, unknown>[]) {
    if (!inBranch(t.source_branch_id as string) && !inBranch(t.destination_branch_id as string)) continue;
    if (t.status === "received" && !["finalized", "adjusted", "estimated"].includes(t.cost_status as string)) out.push({ kind: "Unfinalised costs", severity: "medium", document: (t.document_number as string) ?? "transfer", href: `/inventory/transfers/${t.id}`, detail: `Received; costing ${t.cost_status}`, since: null });
  }
  for (const l of (quarantine.data ?? []) as unknown as { transfer_id: string; qty_quarantined: number; qty_short_pending: number; product: { name: string } | null }[]) {
    const t = ((transfers.data ?? []) as Record<string, unknown>[]).find((x) => x.id === l.transfer_id);
    if (!t || (!inBranch(t.source_branch_id as string) && !inBranch(t.destination_branch_id as string))) continue;
    out.push({ kind: "Unresolved losses", severity: "high", document: (t.document_number as string) ?? "transfer", href: `/inventory/transfers/${t.id}`,
      detail: `${l.product?.name}: ${N(l.qty_quarantined)} quarantined, ${N(l.qty_short_pending)} short awaiting resolution`, since: null });
  }
  const dnSet = new Set(((versions.data ?? []) as { owner_id: string }[]).map((v) => v.owner_id));
  for (const tr of (trips.data ?? []) as unknown as { id: string; transfer_id: string; document_number: string | null; status: string; expected_arrival_at: string | null; transfer: { source_branch_id: string; destination_branch_id: string } }[]) {
    if (!inBranch(tr.transfer.source_branch_id) && !inBranch(tr.transfer.destination_branch_id)) continue;
    const href = `/inventory/transfers/${tr.transfer_id}`, doc = tr.document_number ?? "trip";
    if (tr.status !== "received" && tr.expected_arrival_at && tr.expected_arrival_at.slice(0, 10) < today) out.push({ kind: "Overdue arrival", severity: "high", document: doc, href, detail: `ETA passed, trip ${tr.status}`, since: tr.expected_arrival_at.slice(0, 10) });
    if (!dnSet.has(tr.id)) out.push({ kind: "Missing documents", severity: "medium", document: doc, href, detail: "No delivery note issued", since: null });
    if (tr.status === "received" && !has(tr.id, ["signed_delivery_note", "proof_of_delivery"])) out.push({ kind: "Missing documents", severity: "medium", document: doc, href, detail: "Received without a signed delivery note / proof of delivery", since: null });
  }
  for (const c of (srcs.data ?? []) as Record<string, unknown>[]) {
    const href = c.import_shipment_id ? `/imports/${c.import_shipment_id}` : c.stock_transfer_id ? `/inventory/transfers/${c.stock_transfer_id}` : c.rebag_order_id ? `/inventory/rebagging/${c.rebag_order_id}` : c.purchase_id ? `/purchases/${c.purchase_id}` : null;
    if (c.status === "accrued" && c.accrual_date && (c.accrual_date as string) <= addDays(today, -accrualDays))
      out.push({ kind: "Unmatched accruals", severity: "medium", document: (c.description as string) ?? "cost", href, detail: `Accrued ${N(c.accrued_amount).toLocaleString("en-US")} on ${c.accrual_date}, no invoice after ${accrualDays} days`, since: c.accrual_date as string });
    const posted = c.status === "invoiced" ? N(c.actual_amount) : c.status === "accrued" ? N(c.accrued_amount) : 0;
    if (c.owner_type === "import_shipment" && c.inventory_treatment === "capitalize" && Math.abs(posted - N(c.capitalised_applied)) > 0.009)
      out.push({ kind: "Unallocated charges", severity: "high", document: (c.description as string) ?? "cost", href, detail: `${r2(posted - N(c.capitalised_applied)).toLocaleString("en-US")} not yet allocated to stock`, since: null });
  }
  for (const r of (recon.data ?? []) as { check_key: string; label: string; ok: boolean; detail: string }[]) {
    if (!r.ok) out.push({ kind: "Stock / GL differences", severity: "high", document: r.label, href: "/reports/cost-reconciliation", detail: r.detail, since: null });
  }
  return out;
}
function addDays(iso: string, days: number) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
