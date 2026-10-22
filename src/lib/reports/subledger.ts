import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { accountBalanceByCode, round2 } from "@/lib/reports/queries";
import { localDayEnd } from "@/lib/format";

const N = (v: unknown) => Number(v ?? 0);
function addDays(d: string, n: number) { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function bucketOf(dueOrDoc: string, asOf: string): string {
  const days = Math.floor((Date.parse(asOf) - Date.parse(dueOrDoc)) / 86400000);
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90";
}
export const EMPTY_BUCKETS = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 };

/* ------------------------------- VAT ------------------------------------ */
export async function vatReport(companyId: string, start: string, end: string) {
  const admin = createAdminClient();
  const inRange = (q: ReturnType<ReturnType<typeof createAdminClient>["from"]>) => q;
  void inRange;
  const [sales, sreturns, income, purchases, preturns, expenses] = await Promise.all([
    admin.from("sales").select("tax_total, net_total").eq("company_id", companyId).eq("document_status", "posted").gte("document_date", start).lte("document_date", end),
    admin.from("sales_returns").select("tax_total, net_total").eq("company_id", companyId).eq("document_status", "posted").gte("document_date", start).lte("document_date", end),
    admin.from("other_income_transactions").select("tax_total, net_total").eq("company_id", companyId).eq("document_status", "posted").gte("document_date", start).lte("document_date", end),
    admin.from("purchases").select("recoverable_tax, net_total").eq("company_id", companyId).eq("document_status", "posted").gte("document_date", start).lte("document_date", end),
    admin.from("purchase_returns").select("id, document_date").eq("company_id", companyId).eq("document_status", "posted").gte("document_date", start).lte("document_date", end),
    admin.from("expenses").select("recoverable_tax, nonrecoverable_tax, net_total").eq("company_id", companyId).eq("document_status", "posted").gte("document_date", start).lte("document_date", end),
  ]);
  const sum = (rows: Record<string, unknown>[] | null, f: string) => round2((rows ?? []).reduce((s, r) => s + N(r[f]), 0));
  // recoverable VAT reversed on purchase returns
  let prReclaim = 0;
  const prIds = (preturns.data ?? []).map((r) => r.id as string);
  if (prIds.length) {
    const { data: prl } = await admin.from("purchase_return_lines").select("tax_amount, is_recoverable").in("return_id", prIds);
    prReclaim = round2((prl ?? []).filter((l) => l.is_recoverable).reduce((s, l) => s + N(l.tax_amount), 0));
  }

  const outputSales = sum(sales.data, "tax_total");
  const outputReturns = sum(sreturns.data, "tax_total");
  const outputIncome = sum(income.data, "tax_total");
  const outputVat = round2(outputSales - outputReturns + outputIncome);

  const inputPurchases = sum(purchases.data, "recoverable_tax");
  const inputExpenses = sum(expenses.data, "recoverable_tax");
  const inputVat = round2(inputPurchases - prReclaim + inputExpenses);
  const nonRecoverable = sum(expenses.data, "nonrecoverable_tax");
  const netVat = round2(outputVat - inputVat);

  // Reconcile to control accounts (movement over period).
  const out2120 = round2(-(await accountBalanceByCode(companyId, "2120", end)) + (await accountBalanceByCode(companyId, "2120", addDays(start, -1))));
  const in1160 = round2((await accountBalanceByCode(companyId, "1160", end)) - (await accountBalanceByCode(companyId, "1160", addDays(start, -1))));
  return {
    outputSales, outputReturns, outputIncome, outputVat,
    inputPurchases, inputExpenses, inputReturns: prReclaim, inputVat, nonRecoverable, netVat,
    controlOutput: out2120, controlInput: in1160,
    outputReconciled: Math.abs(outputVat - out2120) < 0.05,
    inputReconciled: Math.abs(inputVat - in1160) < 0.05,
  };
}

/* ---------------------------- Receivables ------------------------------- */
export async function receivablesAgeing(companyId: string, asOf: string) {
  const admin = createAdminClient();
  const { data: sales } = await admin.from("sales")
    .select("id, document_number, document_date, due_date, grand_total, customer:customers(id, code, name)")
    .eq("company_id", companyId).eq("document_status", "posted").lte("document_date", asOf);
  const ids = (sales ?? []).map((s) => s.id);
  const [pays, allocs, rets, openings] = await Promise.all([
    ids.length ? admin.from("sale_payments").select("sale_id, amount").in("sale_id", ids).lte("payment_date", asOf) : Promise.resolve({ data: [] }),
    ids.length ? admin.from("customer_receipt_allocations").select("sale_id, amount, receipt:customer_receipts!inner(document_status, document_date)").in("sale_id", ids) : Promise.resolve({ data: [] }),
    ids.length ? admin.from("sales_returns").select("sale_id, receivable_reduction, document_status, document_date").in("sale_id", ids) : Promise.resolve({ data: [] }),
    admin.from("customer_opening_balances").select("customer_id, document_number, invoice_date, due_date, outstanding, customer:customers(code, name)").eq("company_id", companyId).eq("document_status", "posted").lte("invoice_date", asOf),
  ]);
  const payMap = new Map<string, number>();
  for (const p of (pays.data ?? []) as Record<string, unknown>[]) payMap.set(p.sale_id as string, (payMap.get(p.sale_id as string) ?? 0) + N(p.amount));
  const allocMap = new Map<string, number>();
  for (const a of (allocs.data ?? []) as Record<string, unknown>[]) {
    const r = a.receipt as { document_status: string; document_date: string } | null;
    if (r?.document_status === "posted" && r.document_date <= asOf) allocMap.set(a.sale_id as string, (allocMap.get(a.sale_id as string) ?? 0) + N(a.amount));
  }
  const retMap = new Map<string, number>();
  for (const r of (rets.data ?? []) as Record<string, unknown>[]) {
    if (r.document_status === "posted" && (r.document_date as string) <= asOf) retMap.set(r.sale_id as string, (retMap.get(r.sale_id as string) ?? 0) + N(r.receivable_reduction));
  }

  const rows: { entity: string; doc: string; date: string; due: string; original: number; outstanding: number; bucket: string }[] = [];
  const buckets = { ...EMPTY_BUCKETS };
  for (const s of (sales ?? []) as Record<string, unknown>[]) {
    const out = round2(N(s.grand_total) - (payMap.get(s.id as string) ?? 0) - (allocMap.get(s.id as string) ?? 0) - (retMap.get(s.id as string) ?? 0));
    if (out <= 0.005) continue;
    const cust = s.customer as { name: string } | null;
    const due = (s.due_date as string) ?? (s.document_date as string);
    const b = bucketOf(due, asOf);
    buckets[b as keyof typeof buckets] = round2(buckets[b as keyof typeof buckets] + out);
    rows.push({ entity: cust?.name ?? "—", doc: (s.document_number as string) ?? "—", date: s.document_date as string, due, original: N(s.grand_total), outstanding: out, bucket: b });
  }
  for (const o of (openings.data ?? []) as Record<string, unknown>[]) {
    const out = round2(N(o.outstanding));
    if (out <= 0.005) continue;
    const cust = o.customer as { name: string } | null;
    const due = (o.due_date as string) ?? (o.invoice_date as string);
    const b = bucketOf(due, asOf);
    buckets[b as keyof typeof buckets] = round2(buckets[b as keyof typeof buckets] + out);
    rows.push({ entity: cust?.name ?? "—", doc: (o.document_number as string) ?? "Opening", date: o.invoice_date as string, due, original: N(o.outstanding), outstanding: out, bucket: b });
  }
  const total = round2(rows.reduce((s, r) => s + r.outstanding, 0));
  const control = await accountBalanceByCode(companyId, "1140", asOf);
  return { rows, buckets, total, control, reconciled: Math.abs(total - control) < 0.05 };
}

/* ----------------------------- Payables --------------------------------- */
export async function payablesAgeing(companyId: string, asOf: string) {
  const admin = createAdminClient();
  const [purchases, expenses, openings, fcEvents, creditApps, costPayables, adjustments] = await Promise.all([
    admin.from("purchases").select("id, document_number, document_date, due_date, grand_total, currency_code, fc_grand_total, advance_applied_at_rate, supplier:suppliers(name)").eq("company_id", companyId).eq("document_status", "posted").lte("document_date", asOf),
    admin.from("expenses").select("id, document_number, document_date, due_date, grand_total, supplier:suppliers(name)").eq("company_id", companyId).eq("document_status", "posted").lte("document_date", asOf),
    admin.from("supplier_opening_balances").select("document_number, document_date, due_date, outstanding, supplier:suppliers(name)").eq("company_id", companyId).eq("document_status", "posted").lte("document_date", asOf),
    // Foreign invoices: balance as of the date is rebuilt from the event log.
    admin.from("supplier_payable_events").select("fc_delta, tzs_delta, payable:supplier_payables!inner(purchase_id)").eq("company_id", companyId).lte("event_date", asOf),
    admin.from("supplier_credit_applications").select("payable_tzs_released, payable:supplier_payables!inner(purchase_id, currency_code)").eq("company_id", companyId).lte("application_date", asOf),
    // Service invoices (import, rebagging, transfer and purchase costs): balance from their payable.
    admin.from("supplier_payables").select("outstanding, original_amount, invoice:cost_invoices!inner(document_number, document_date, due_date, document_status), supplier:suppliers(name)")
      .eq("company_id", companyId).not("cost_invoice_id", "is", null).neq("status", "voided").lte("invoice.document_date", asOf),
    // Supplier price debit / credit notes on purchases (Stage 7).
    admin.from("purchase_cost_adjustments").select("purchase_id, payable_delta").eq("company_id", companyId).eq("document_status", "posted").lte("document_date", asOf),
  ]);
  const adjMap = new Map<string, number>();
  for (const a of (adjustments.data ?? []) as { purchase_id: string; payable_delta: number }[]) adjMap.set(a.purchase_id, (adjMap.get(a.purchase_id) ?? 0) + N(a.payable_delta));
  const fcMap = new Map<string, { fc: number; tzs: number }>();
  for (const e of (fcEvents.data ?? []) as Record<string, unknown>[]) {
    const pid = (e.payable as { purchase_id: string } | null)?.purchase_id; if (!pid) continue;
    const cur = fcMap.get(pid) ?? { fc: 0, tzs: 0 };
    fcMap.set(pid, { fc: round2(cur.fc + N(e.fc_delta)), tzs: round2(cur.tzs + N(e.tzs_delta)) });
  }
  const creditMap = new Map<string, number>();
  for (const c of (creditApps.data ?? []) as Record<string, unknown>[]) {
    const pb = c.payable as { purchase_id: string; currency_code: string } | null;
    if (!pb || pb.currency_code !== "TZS") continue;
    creditMap.set(pb.purchase_id, (creditMap.get(pb.purchase_id) ?? 0) + N(c.payable_tzs_released));
  }
  const pIds = (purchases.data ?? []).map((p) => p.id);
  const eIds = (expenses.data ?? []).map((e) => e.id);
  const [pPays, ePays, allocs, pRets] = await Promise.all([
    pIds.length ? admin.from("purchase_payments").select("purchase_id, amount").in("purchase_id", pIds).lte("payment_date", asOf) : Promise.resolve({ data: [] }),
    eIds.length ? admin.from("expense_payments").select("expense_id, amount").in("expense_id", eIds).lte("payment_date", asOf) : Promise.resolve({ data: [] }),
    admin.from("supplier_payment_allocations").select("amount, payment:supplier_payments!inner(document_status, document_date), payable:supplier_payables!inner(purchase_id, expense_id)").eq("payment.document_status", "posted").lte("payment.document_date", asOf),
    pIds.length ? admin.from("purchase_returns").select("purchase_id, payable_reduction, document_status, document_date").in("purchase_id", pIds) : Promise.resolve({ data: [] }),
  ]);
  const pPayMap = new Map<string, number>(); for (const p of (pPays.data ?? []) as Record<string, unknown>[]) pPayMap.set(p.purchase_id as string, (pPayMap.get(p.purchase_id as string) ?? 0) + N(p.amount));
  const ePayMap = new Map<string, number>(); for (const p of (ePays.data ?? []) as Record<string, unknown>[]) ePayMap.set(p.expense_id as string, (ePayMap.get(p.expense_id as string) ?? 0) + N(p.amount));
  const allocMap = new Map<string, number>();
  for (const a of (allocs.data ?? []) as Record<string, unknown>[]) {
    const pb = a.payable as { purchase_id: string | null; expense_id: string | null } | null;
    const key = pb?.purchase_id ?? pb?.expense_id; if (!key) continue;
    allocMap.set(key, (allocMap.get(key) ?? 0) + N(a.amount));
  }
  const retMap = new Map<string, number>();
  for (const r of (pRets.data ?? []) as Record<string, unknown>[]) if (r.document_status === "posted" && (r.document_date as string) <= asOf) retMap.set(r.purchase_id as string, (retMap.get(r.purchase_id as string) ?? 0) + N(r.payable_reduction));

  // outstanding is always TZS (carrying amount for foreign invoices); the
  // foreign figures are shown alongside, never added to TZS.
  const rows: { entity: string; doc: string; date: string; due: string; original: number; outstanding: number; bucket: string;
    currency: string; fcOriginal: number | null; fcOutstanding: number | null }[] = [];
  const buckets = { ...EMPTY_BUCKETS };
  const push = (entity: string, doc: string, date: string, due: string, original: number, out: number,
    currency = "TZS", fcOriginal: number | null = null, fcOutstanding: number | null = null) => {
    if (out <= 0.005 && !(fcOutstanding && fcOutstanding > 0.005)) return;
    const b = bucketOf(due, asOf);
    buckets[b as keyof typeof buckets] = round2(buckets[b as keyof typeof buckets] + out);
    rows.push({ entity, doc, date, due, original, outstanding: out, bucket: b, currency, fcOriginal, fcOutstanding });
  };
  for (const p of (purchases.data ?? []) as Record<string, unknown>[]) {
    const entity = (p.supplier as { name: string } | null)?.name ?? "—";
    const due = (p.due_date as string) ?? (p.document_date as string);
    if (p.currency_code !== "TZS") {
      const ev = fcMap.get(p.id as string) ?? { fc: 0, tzs: 0 };
      push(entity, (p.document_number as string) ?? "—", p.document_date as string, due, N(p.grand_total), ev.tzs,
        p.currency_code as string, N(p.fc_grand_total), ev.fc);
      continue;
    }
    const out = round2(N(p.grand_total) - (pPayMap.get(p.id as string) ?? 0) - (allocMap.get(p.id as string) ?? 0)
      - (retMap.get(p.id as string) ?? 0) - N(p.advance_applied_at_rate) - (creditMap.get(p.id as string) ?? 0) - (adjMap.get(p.id as string) ?? 0));
    push(entity, (p.document_number as string) ?? "—", p.document_date as string, due, N(p.grand_total), out);
  }
  for (const e of (expenses.data ?? []) as Record<string, unknown>[]) {
    const out = round2(N(e.grand_total) - (ePayMap.get(e.id as string) ?? 0) - (allocMap.get(e.id as string) ?? 0));
    push((e.supplier as { name: string } | null)?.name ?? "—", (e.document_number as string) ?? "—", e.document_date as string, (e.due_date as string) ?? (e.document_date as string), N(e.grand_total), out);
  }
  for (const c of (costPayables.data ?? []) as Record<string, unknown>[]) {
    const inv = c.invoice as { document_number: string | null; document_date: string; due_date: string | null };
    push((c.supplier as { name: string } | null)?.name ?? "—", inv.document_number ?? "—", inv.document_date, inv.due_date ?? inv.document_date, N(c.original_amount), round2(N(c.outstanding)));
  }
  for (const o of (openings.data ?? []) as Record<string, unknown>[]) {
    push((o.supplier as { name: string } | null)?.name ?? "—", (o.document_number as string) ?? "Opening", o.document_date as string, (o.due_date as string) ?? (o.document_date as string), N(o.outstanding), round2(N(o.outstanding)));
  }
  const total = round2(rows.reduce((s, r) => s + r.outstanding, 0));
  const control = await accountBalanceByCode(companyId, "2110", asOf);
  return { rows, buckets, total, control, reconciled: Math.abs(total - control) < 0.05 };
}

/* ------------------------ Inventory valuation --------------------------- */
export async function inventoryValuation(companyId: string, branchId: string | null, asOf: string, isToday: boolean) {
  const admin = createAdminClient();
  const rows: { sku: string; name: string; branch: string; quantity: number; avgCost: number; value: number; lastMovement: string | null }[] = [];
  if (isToday) {
    let q = admin.from("stock_balances")
      .select("quantity, avg_unit_cost, stock_value, last_movement_at, product:products(sku, name), branch:branches(code)")
      .eq("company_id", companyId).gt("quantity", 0);
    if (branchId) q = q.eq("branch_id", branchId);
    for (const r of ((await q).data ?? []) as Record<string, unknown>[]) {
      rows.push({ sku: (r.product as { sku: string })?.sku ?? "—", name: (r.product as { name: string })?.name ?? "—", branch: (r.branch as { code: string })?.code ?? "—", quantity: N(r.quantity), avgCost: N(r.avg_unit_cost), value: N(r.stock_value), lastMovement: (r.last_movement_at as string) ?? null });
    }
  } else {
    // Reconstruct from immutable movements: last movement per (branch, product) on/before asOf.
    let q = admin.from("stock_movements")
      .select("branch_id, product_id, balance_qty, avg_cost_after, balance_value, created_at, product:products(sku, name), branch:branches(code)")
      .eq("company_id", companyId).lte("created_at", localDayEnd(asOf)).order("created_at", { ascending: false });
    if (branchId) q = q.eq("branch_id", branchId);
    const seen = new Set<string>();
    for (const r of ((await q).data ?? []) as Record<string, unknown>[]) {
      const key = `${r.branch_id}:${r.product_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (N(r.balance_qty) <= 0) continue;
      rows.push({ sku: (r.product as { sku: string })?.sku ?? "—", name: (r.product as { name: string })?.name ?? "—", branch: (r.branch as { code: string })?.code ?? "—", quantity: N(r.balance_qty), avgCost: N(r.avg_cost_after), value: N(r.balance_value), lastMovement: (r.created_at as string) ?? null });
    }
  }
  const total = round2(rows.reduce((s, r) => s + r.value, 0));
  const control = await accountBalanceByCode(companyId, "1150", asOf);
  // Value held in 1150 outside the stock balances (current position only):
  // bulk issued to rebagging orders still in production, and transfers
  // dispatched before the transfer upgrade (their in-transit value stayed in 1150).
  let held = 0;
  if (isToday && !branchId) {
    const [{ data: wip }, { data: legacy }] = await Promise.all([
      admin.from("rebag_orders").select("issued_value").eq("company_id", companyId).eq("document_status", "issued"),
      admin.from("stock_transfers").select("lines:stock_transfer_lines(qty_dispatched, qty_received, unit_cost)").eq("company_id", companyId)
        .eq("posts_in_transit", false).in("status", ["dispatched", "partially_received"]),
    ]);
    held = round2((wip ?? []).reduce((a, r) => a + N(r.issued_value), 0)
      + ((legacy ?? []) as unknown as { lines: { qty_dispatched: number; qty_received: number; unit_cost: number }[] }[])
        .reduce((a, t) => a + t.lines.reduce((b, l) => b + round2((N(l.qty_dispatched) - N(l.qty_received)) * N(l.unit_cost)), 0), 0));
  }
  return { rows, total, held, control, reconciled: Math.abs(total + held - control) < 0.05 };
}

/** Goods in transit between branches (1155) vs the value on trips not yet received. Current position. */
export async function goodsInTransit(companyId: string, asOf: string) {
  const admin = createAdminClient();
  const { data } = await admin.from("stock_transfer_dispatch_lines")
    .select("transit_value, trip:stock_transfer_dispatches!inner(company_id, status)").eq("trip.company_id", companyId).not("trip.status", "in", "(draft,voided)");
  const total = round2(((data ?? []) as { transit_value: number }[]).reduce((a, r) => a + N(r.transit_value), 0));
  const control = await accountBalanceByCode(companyId, "1155", asOf);
  return { total, control, reconciled: Math.abs(total - control) < 0.05 };
}

/* --------------------------- Statements --------------------------------- */
export interface StatementRow { date: string; doc: string; type: string; debit: number; credit: number; running: number }

export async function customerStatement(companyId: string, customerId: string, start: string, end: string) {
  const admin = createAdminClient();
  const [sales, allocs, rets, openings] = await Promise.all([
    admin.from("sales").select("document_number, document_date, grand_total").eq("company_id", companyId).eq("customer_id", customerId).eq("document_status", "posted"),
    admin.from("customer_receipt_allocations").select("amount, sale:sales!inner(customer_id), receipt:customer_receipts!inner(document_number, document_date, document_status, customer_id)").eq("receipt.customer_id", customerId).eq("receipt.document_status", "posted"),
    admin.from("sales_returns").select("document_number, document_date, total").eq("company_id", companyId).eq("customer_id", customerId).eq("document_status", "posted"),
    admin.from("customer_opening_balances").select("document_number, invoice_date, amount").eq("company_id", companyId).eq("customer_id", customerId).eq("document_status", "posted"),
  ]);
  type Ev = { date: string; doc: string; type: string; debit: number; credit: number };
  const evs: Ev[] = [];
  for (const s of (sales.data ?? []) as Record<string, unknown>[]) evs.push({ date: s.document_date as string, doc: (s.document_number as string) ?? "—", type: "Invoice", debit: N(s.grand_total), credit: 0 });
  for (const o of (openings.data ?? []) as Record<string, unknown>[]) evs.push({ date: o.invoice_date as string, doc: (o.document_number as string) ?? "Opening", type: "Opening", debit: N(o.amount), credit: 0 });
  for (const a of (allocs.data ?? []) as Record<string, unknown>[]) { const r = a.receipt as { document_number: string; document_date: string }; evs.push({ date: r.document_date, doc: r.document_number ?? "Receipt", type: "Receipt", debit: 0, credit: N(a.amount) }); }
  for (const r of (rets.data ?? []) as Record<string, unknown>[]) evs.push({ date: r.document_date as string, doc: (r.document_number as string) ?? "Return", type: "Return", debit: 0, credit: N(r.total) });
  return buildStatement(evs, start, end);
}

/**
 * Supplier statement, one section per currency. TZS documents form the TZS
 * statement; each foreign currency gets its own statement in that currency
 * (never added to TZS), plus the TZS carrying amount of its open invoices as
 * of the end date (from the payable event log). Advances and returns reduce
 * the balance when they occur; applying a credit or advance later moves no
 * balance between sections.
 */
export async function supplierStatement(companyId: string, supplierId: string, start: string, end: string) {
  const admin = createAdminClient();
  const [purchases, expenses, allocs, rets, openings, advances, events] = await Promise.all([
    admin.from("purchases").select("id, document_number, document_date, grand_total, currency_code, fc_grand_total").eq("company_id", companyId).eq("supplier_id", supplierId).eq("document_status", "posted"),
    admin.from("expenses").select("document_number, document_date, grand_total").eq("company_id", companyId).eq("supplier_id", supplierId).eq("document_status", "posted"),
    admin.from("supplier_payment_allocations").select("amount, fc_amount, payment:supplier_payments!inner(document_number, document_date, document_status, supplier_id, currency_code)").eq("payment.supplier_id", supplierId).eq("payment.document_status", "posted"),
    admin.from("purchase_returns").select("document_number, document_date, total, currency_code, fc_total").eq("company_id", companyId).eq("supplier_id", supplierId).eq("document_status", "posted"),
    admin.from("supplier_opening_balances").select("document_number, document_date, amount").eq("company_id", companyId).eq("supplier_id", supplierId).eq("document_status", "posted"),
    admin.from("supplier_advances").select("currency_code, advance_date, fc_amount, status, payment:supplier_payments(document_number)").eq("company_id", companyId).eq("supplier_id", supplierId).neq("status", "voided"),
    admin.from("supplier_payable_events").select("tzs_delta, event_date, payable:supplier_payables!inner(supplier_id, currency_code)").eq("company_id", companyId).eq("payable.supplier_id", supplierId).lte("event_date", end),
  ]);
  type Ev = { date: string; doc: string; type: string; debit: number; credit: number };
  const byCur = new Map<string, Ev[]>();
  const add = (cur: string, e: Ev) => { if (!byCur.has(cur)) byCur.set(cur, []); byCur.get(cur)!.push(e); };
  byCur.set("TZS", []);
  // Supplier statement: credit increases what we owe, debit reduces it.
  for (const p of (purchases.data ?? []) as Record<string, unknown>[]) {
    const cur = p.currency_code as string;
    add(cur, { date: p.document_date as string, doc: (p.document_number as string) ?? "—", type: "Purchase", debit: 0, credit: cur === "TZS" ? N(p.grand_total) : N(p.fc_grand_total) });
  }
  for (const e of (expenses.data ?? []) as Record<string, unknown>[]) add("TZS", { date: e.document_date as string, doc: (e.document_number as string) ?? "—", type: "Expense", debit: 0, credit: N(e.grand_total) });
  for (const o of (openings.data ?? []) as Record<string, unknown>[]) add("TZS", { date: o.document_date as string, doc: (o.document_number as string) ?? "Opening", type: "Opening", debit: 0, credit: N(o.amount) });
  for (const a of (allocs.data ?? []) as Record<string, unknown>[]) {
    const p = a.payment as { document_number: string; document_date: string; currency_code: string };
    add(p.currency_code, { date: p.document_date, doc: p.document_number ?? "Payment", type: "Payment", debit: p.currency_code === "TZS" ? N(a.amount) : N(a.fc_amount), credit: 0 });
  }
  for (const v of (advances.data ?? []) as Record<string, unknown>[]) {
    const pay = v.payment as { document_number: string | null } | null;
    add(v.currency_code as string, { date: v.advance_date as string, doc: pay?.document_number ?? "Advance", type: "Advance", debit: N(v.fc_amount), credit: 0 });
  }
  for (const r of (rets.data ?? []) as Record<string, unknown>[]) {
    const cur = r.currency_code as string;
    add(cur, { date: r.document_date as string, doc: (r.document_number as string) ?? "Return", type: "Return", debit: cur === "TZS" ? N(r.total) : N(r.fc_total), credit: 0 });
  }
  const carrying = new Map<string, number>();
  for (const e of (events.data ?? []) as Record<string, unknown>[]) {
    const cur = (e.payable as { currency_code: string } | null)?.currency_code; if (!cur) continue;
    carrying.set(cur, round2((carrying.get(cur) ?? 0) + N(e.tzs_delta)));
  }
  const tzs = buildStatement(byCur.get("TZS") ?? [], start, end);
  const foreign = Array.from(byCur.keys()).filter((c) => c !== "TZS").sort().map((currency) => ({
    currency, ...buildStatement(byCur.get(currency) ?? [], start, end), carryingOpenInvoices: carrying.get(currency) ?? 0,
  }));
  return { ...tzs, foreign };
}

function buildStatement(evs: { date: string; doc: string; type: string; debit: number; credit: number }[], start: string, end: string) {
  evs.sort((a, b) => (a.date < b.date ? -1 : 1));
  let opening = 0;
  const rows: StatementRow[] = [];
  let running = 0;
  for (const e of evs) {
    if (e.date < start) { opening = round2(opening + e.debit - e.credit); continue; }
  }
  running = opening;
  for (const e of evs) {
    if (e.date < start || e.date > end) continue;
    running = round2(running + e.debit - e.credit);
    rows.push({ date: e.date, doc: e.doc, type: e.type, debit: e.debit, credit: e.credit, running });
  }
  return { opening, rows, closing: running };
}

/* -------------------- Reconciliation control panel ---------------------- */
export async function reconciliationControls(companyId: string, asOf: string) {
  const admin = createAdminClient();
  const controls: { key: string; label: string; subledger: number; gl: number; difference: number; status: string }[] = [];
  const add = (key: string, label: string, sub: number, gl: number) => {
    const diff = round2(sub - gl);
    controls.push({ key, label, subledger: round2(sub), gl: round2(gl), difference: diff, status: Math.abs(diff) < 0.05 ? "Reconciled" : "Difference Found" });
  };

  const ar = await receivablesAgeing(companyId, asOf);
  add("ar", "Customer receivables vs A/R", ar.total, ar.control);
  const ap = await payablesAgeing(companyId, asOf);
  add("ap", "Supplier payables vs A/P", ap.total, ap.control);
  const inv = await inventoryValuation(companyId, null, asOf, true);
  add("inv", "Inventory valuation (+ work in progress, legacy transit) vs Inventory GL", round2(inv.total + inv.held), inv.control);
  const git = await goodsInTransit(companyId, asOf);
  add("git", "Stock in transit between branches vs 1155", git.total, git.control);

  // Journal debits vs credits (global)
  const { data: je } = await admin.rpc("report_trial_balance", { p_company: companyId, p_start: "1900-01-01", p_end: asOf });
  const totDr = round2((je ?? []).reduce((s: number, r: Record<string, unknown>) => s + Math.max(N(r.closing_net), 0), 0));
  const totCr = round2((je ?? []).reduce((s: number, r: Record<string, unknown>) => s + Math.max(-N(r.closing_net), 0), 0));
  add("journal", "Journal debits vs credits", totDr, totCr);

  return controls;
}
