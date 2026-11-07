"use server";

/**
 * Payment-first sales: Sales Request -> ONE manager approval -> approved Sales
 * Order -> truck shipments. Every state change runs in one database function
 * (migration 0044); these actions only check the caller, build trusted line
 * snapshots and translate results for the screens.
 */
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission, assertBranchAccess } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import { callPostingRpc, type RpcResult } from "@/lib/rpc";
import { calcLine, round2 } from "@/lib/sales/calc";
import { earnedFreeGoods, type PromotionRule } from "@/lib/sales/promotions";
import { todayISO } from "@/lib/format";

type Admin = ReturnType<typeof createAdminClient>;
const fail = (e: unknown): RpcResult => ({ ok: false, error: e instanceof Error ? e.message : "Failed." });

function refresh(...paths: string[]) {
  for (const p of ["/sales/workspace", "/sales/approvals", ...paths]) revalidatePath(p);
}

/* ------------------------------------------------------------------ requests */

export interface RequestLineInput { product_id: string; quantity: number; unit_price: number; discount: number; tax_code_id?: string | null }
export interface RequestPaymentInput { payment_method: string; payment_account_id: string; payment_date: string; amount: number; reference: string }
export interface RequestFundInput { receipt_id: string; amount: number }
export interface SalesRequestInput {
  requestId?: string;
  branchId: string;
  customerId: string;
  contactName?: string; contactPhone?: string;
  fulfilmentMode: "collection" | "delivery";
  fulfilmentLocation?: string;
  destination?: string; consigneeName?: string; consigneePhone?: string;
  notes?: string;
  orderDiscount?: number;
  lines: RequestLineInput[];
  payments: RequestPaymentInput[];
  funds: RequestFundInput[];
  redeemRewards?: boolean;
}

function toRule(r: Record<string, unknown>): PromotionRule {
  return {
    id: String(r.id), name: String(r.name), product_id: String(r.product_id),
    min_quantity: Number(r.min_quantity), free_quantity: Number(r.free_quantity),
    repeat_per_multiple: r.repeat_per_multiple === true, reward_timing: r.reward_timing as PromotionRule["reward_timing"],
    starts_on: String(r.starts_on), ends_on: (r.ends_on as string | null) ?? null,
  };
}
const RULE_COLS = "id, name, product_id, min_quantity, free_quantity, repeat_per_multiple, reward_timing, starts_on, ends_on";

/** Free-goods lines: same-order promotions plus rewards earned in earlier orders. */
async function freeLines(admin: Admin, companyId: string, customerId: string, bought: Map<string, number>, redeem: boolean) {
  const { data: cust } = await admin.from("customers").select("is_protected").eq("id", customerId).maybeSingle();
  if (!cust || cust.is_protected || bought.size === 0) return [];
  const { data: rules } = await admin.from("sales_promotions").select(RULE_COLS)
    .eq("company_id", companyId).eq("is_active", true).eq("reward_timing", "current_order").in("product_id", [...bought.keys()]);
  const earned = earnedFreeGoods((rules ?? []).map(toRule), bought, todayISO(), false);
  const rewards = !redeem ? [] : ((await admin.from("promotion_rewards")
    .select("id, promotion_id, product_id, quantity, promotion:sales_promotions(name)")
    .eq("company_id", companyId).eq("customer_id", customerId).eq("status", "available")).data ?? []) as unknown as
    { id: string; promotion_id: string; product_id: string; quantity: number; promotion: { name: string } | null }[];
  const ids = [...new Set([...earned.map((e) => e.promotion.product_id), ...rewards.map((r) => r.product_id)])];
  if (!ids.length) return [];
  const { data: prods } = await admin.from("products").select("id, name, selling_price, track_inventory, is_active").in("id", ids);
  const pm = new Map((prods ?? []).map((p) => [p.id, p]));
  const row = (productId: string, quantity: number, label: string, promotionId: string, rewardId: string | null) => {
    const p = pm.get(productId);
    if (!p || !p.is_active) return null;
    return {
      product_id: productId, description: `${p.name} - FREE (${label})`, quantity, unit_price: 0, original_price: Number(p.selling_price),
      discount: 0, tax_code_id: null, tax_rate: 0, tax_type: null, tax_name: null, tax_inclusive: false,
      track_inventory: p.track_inventory, is_free: true, promotion_id: promotionId, promotion_reward_id: rewardId,
    };
  };
  return [
    ...earned.map((e) => row(e.promotion.product_id, e.quantity, e.promotion.name, e.promotion.id, null)),
    ...rewards.map((r) => row(r.product_id, Number(r.quantity), `${r.promotion?.name ?? "promotion"}, earned earlier`, r.promotion_id, r.id)),
  ].filter(Boolean) as Record<string, unknown>[];
}

/** Saves a draft (or returned) Sales Request. Nothing is posted: no stock, revenue or receipt. */
export async function saveSalesRequest(input: SalesRequestInput): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, input.requestId ? "sales.edit_draft" : "sales.create");
    const ctx = await getActiveContext();
    assertBranchAccess(user, input.branchId);
    if (!input.customerId) return { ok: false, error: "Choose a customer." };
    if (input.lines.length === 0) return { ok: false, error: "Add at least one product." };
    if (input.fulfilmentMode === "delivery" && !input.destination?.trim()) return { ok: false, error: "Enter the delivery destination." };
    const admin = createAdminClient();

    const { data: cust } = await admin.from("customers").select("company_id, is_active").eq("id", input.customerId).maybeSingle();
    if (!cust || cust.company_id !== ctx.companyId || !cust.is_active) return { ok: false, error: "Customer not found." };

    const { data: products } = await admin.from("products")
      .select("id, name, sku, selling_price, tax_code_id, track_inventory, is_active, company_id").in("id", input.lines.map((l) => l.product_id));
    const pMap = new Map((products ?? []).map((p) => [p.id, p]));
    const taxIds = [...new Set([...input.lines.map((l) => l.tax_code_id), ...(products ?? []).map((p) => p.tax_code_id)].filter(Boolean) as string[])];
    const { data: taxes } = taxIds.length
      ? await admin.from("tax_codes").select("id, name, tax_type, rate, is_inclusive, company_id").in("id", taxIds)
      : { data: [] as { id: string; name: string; tax_type: string; rate: number; is_inclusive: boolean; company_id: string }[] };
    const tMap = new Map((taxes ?? []).map((t) => [t.id, t]));
    const canOverride = userHasPermission(user, "sales.override_price");

    const rows = input.lines.map((l) => {
      const p = pMap.get(l.product_id);
      if (!p || p.company_id !== ctx.companyId) throw new Error("A selected product is invalid.");
      if (!p.is_active) throw new Error(`Product ${p.sku} is inactive.`);
      if (!(l.quantity > 0)) throw new Error("Quantity must be greater than zero.");
      if (l.unit_price < 0 || l.discount < 0) throw new Error("Price and discount cannot be negative.");
      if (round2(l.unit_price) !== round2(Number(p.selling_price)) && !canOverride) throw new Error("You are not allowed to change the selling price.");
      const taxId = l.tax_code_id === undefined ? p.tax_code_id : l.tax_code_id;
      const tc = taxId ? tMap.get(taxId) : null;
      if (tc && tc.company_id !== ctx.companyId) throw new Error("Tax code belongs to another company.");
      return {
        product_id: p.id, description: p.name, quantity: l.quantity, unit_price: l.unit_price, original_price: Number(p.selling_price),
        discount: round2(l.discount), tax_code_id: tc ? tc.id : null, tax_rate: tc ? Number(tc.rate) : 0, tax_type: tc?.tax_type ?? null,
        tax_name: tc?.name ?? null, tax_inclusive: tc ? tc.is_inclusive : false, track_inventory: p.track_inventory,
      };
    });

    // An order-level discount is spread over the paid lines by value (remainder on the largest line).
    const orderDiscount = round2(Number(input.orderDiscount || 0));
    if (orderDiscount < 0) return { ok: false, error: "The order discount cannot be negative." };
    if (orderDiscount > 0) {
      const gross = rows.map((r) => round2(r.quantity * r.unit_price - r.discount));
      const sum = gross.reduce((a, b) => a + b, 0);
      if (orderDiscount > sum + 0.001) return { ok: false, error: "The order discount is more than the order value." };
      let left = orderDiscount;
      const big = gross.indexOf(Math.max(...gross));
      gross.forEach((g, i) => { if (i === big) return; const d = round2(orderDiscount * g / sum); rows[i].discount = round2(rows[i].discount + d); left = round2(left - d); });
      rows[big].discount = round2(rows[big].discount + left);
    }
    for (const r of rows) {
      if (calcLine({ quantity: r.quantity, unitPrice: r.unit_price, discount: r.discount, taxRate: r.tax_rate, taxInclusive: r.tax_inclusive }).base < 0)
        return { ok: false, error: `The discount on ${r.description} is more than its value.` };
    }

    const bought = new Map<string, number>();
    for (const r of rows) bought.set(r.product_id, (bought.get(r.product_id) ?? 0) + r.quantity);
    const free = await freeLines(admin, ctx.companyId, input.customerId, bought, input.redeemRewards !== false);
    const allLines = ([...rows, ...free] as Record<string, unknown>[]).map((r, i) => ({ ...r, line_no: i + 1 }) as Record<string, unknown>);
    const totals = allLines.reduce<{ sub: number; disc: number; net: number; tax: number; grand: number }>((t, r) => {
      const c = calcLine({ quantity: Number(r.quantity), unitPrice: Number(r.unit_price), discount: Number(r.discount), taxRate: Number(r.tax_rate), taxInclusive: r.tax_inclusive === true });
      return { sub: t.sub + c.gross, disc: t.disc + Number(r.discount), net: t.net + c.net, tax: t.tax + c.tax, grand: t.grand + c.lineTotal };
    }, { sub: 0, disc: 0, net: 0, tax: 0, grand: 0 });

    // Payment evidence (verified later by the manager) and existing customer funds.
    for (const p of input.payments) {
      if (!p.payment_account_id || !(p.amount > 0) || !p.reference?.trim() || !p.payment_date) throw new Error("Each payment needs an account, date, amount and transaction reference.");
    }
    const refs = input.payments.map((p) => `${p.payment_account_id}|${p.reference.trim().toLowerCase()}`);
    if (new Set(refs).size !== refs.length) return { ok: false, error: "The same payment reference is entered twice." };
    if (input.payments.length) {
      const { data: dups } = await admin.from("customer_receipts").select("document_number, reference, payment_account_id")
        .eq("company_id", ctx.companyId).neq("document_status", "voided").in("reference", input.payments.map((p) => p.reference.trim()));
      const hit = (dups ?? []).find((d) => refs.includes(`${d.payment_account_id}|${String(d.reference).trim().toLowerCase()}`));
      if (hit) return { ok: false, error: `Payment reference ${hit.reference} is already recorded as receipt ${hit.document_number}. Use it from the customer's available funds instead.` };
    }
    if (input.funds.length) {
      const { data: rs } = await admin.from("customer_receipts").select("id, customer_id, company_id, receipt_kind, document_status").in("id", input.funds.map((f) => f.receipt_id));
      for (const f of input.funds) {
        const r = (rs ?? []).find((x) => x.id === f.receipt_id);
        if (!r || r.company_id !== ctx.companyId || r.customer_id !== input.customerId || r.receipt_kind !== "advance" || r.document_status !== "posted")
          return { ok: false, error: "A selected fund is not a verified payment of this customer." };
        const { data: avail } = await admin.rpc("customer_receipt_available", { p_receipt: f.receipt_id });
        if (!(f.amount > 0) || f.amount > Number(avail ?? 0) + 0.001) return { ok: false, error: `Only ${Number(avail ?? 0).toLocaleString()} TZS is available on a selected receipt.` };
      }
    }

    const header = {
      company_id: ctx.companyId, branch_id: input.branchId, customer_id: input.customerId,
      contact_name: input.contactName?.trim() || null, contact_phone: input.contactPhone?.trim() || null,
      fulfilment_mode: input.fulfilmentMode, fulfilment_location: input.fulfilmentLocation?.trim() || null,
      destination: input.destination?.trim() || null, consignee_name: input.consigneeName?.trim() || null, consignee_phone: input.consigneePhone?.trim() || null,
      notes: input.notes?.trim() || null, order_discount: orderDiscount,
      subtotal: round2(totals.sub), discount_total: round2(totals.disc), net_total: round2(totals.net), tax_total: round2(totals.tax), grand_total: round2(totals.grand),
      updated_by: user.id, updated_at: new Date().toISOString(),
    };

    let id = input.requestId ?? null;
    if (id) {
      const { data: ex } = await admin.from("sales_requests").select("status, company_id, branch_id").eq("id", id).maybeSingle();
      if (!ex || ex.company_id !== ctx.companyId) return { ok: false, error: "Request not found." };
      if (!["draft", "returned"].includes(ex.status)) return { ok: false, error: "Only draft or returned requests can be edited." };
      assertBranchAccess(user, ex.branch_id);
      const { error } = await admin.from("sales_requests").update(header).eq("id", id).in("status", ["draft", "returned"]);
      if (error) return { ok: false, error: error.message };
      await admin.from("sales_request_lines").delete().eq("request_id", id);
      await admin.from("sales_request_payments").delete().eq("request_id", id).is("receipt_id", null);
      await admin.from("sales_request_funds").delete().eq("request_id", id);
    } else {
      const { data, error } = await admin.from("sales_requests").insert({ ...header, created_by: user.id }).select("id").single();
      if (error) return { ok: false, error: error.message };
      id = data.id as string;
    }
    const ins = async (table: string, list: Record<string, unknown>[]) => {
      if (!list.length) return;
      const { error } = await admin.from(table).insert(list.map((r) => ({ ...r, request_id: id })));
      if (error) throw new Error(error.message);
    };
    await ins("sales_request_lines", allLines);
    await ins("sales_request_payments", input.payments.map((p) => ({ payment_method: p.payment_method, payment_account_id: p.payment_account_id,
      payment_date: p.payment_date, amount: round2(p.amount), reference: p.reference.trim() })));
    await ins("sales_request_funds", input.funds.map((f) => ({ receipt_id: f.receipt_id, amount: round2(f.amount) })));

    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: input.branchId,
      action: input.requestId ? "sales_request.edit" : "sales_request.create", resourceType: "sales_request", resourceId: id });
    refresh(`/sales/requests/${id}`);
    return { ok: true, id };
  } catch (e) { return fail(e); }
}

/** Sends the request to the approvers of its branch. */
export async function submitSalesRequest(requestId: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "sales.create");
    const admin = createAdminClient();
    const { data: rq } = await admin.from("sales_requests").select("grand_total, branch_id, company_id").eq("id", requestId).maybeSingle();
    if (!rq) return { ok: false, error: "Request not found." };
    // Payment evidence: each new payment needs proof attached before submission.
    const { count: pays } = await admin.from("sales_request_payments").select("id", { count: "exact", head: true }).eq("request_id", requestId).is("receipt_id", null);
    if ((pays ?? 0) > 0) {
      const { count } = await admin.from("document_attachments").select("id", { count: "exact", head: true })
        .eq("owner_type", "sales_request").eq("owner_id", requestId).eq("category", "proof_of_payment");
      if ((count ?? 0) === 0) return { ok: false, error: "Attach proof of payment before submitting." };
    }
    const funded = await fundsOnRequest(admin, requestId);
    if (funded + 0.001 < Number(rq.grand_total)) {
      return { ok: false, error: `Payments and selected funds (${funded.toLocaleString()} TZS) do not cover the order value (${Number(rq.grand_total).toLocaleString()} TZS).` };
    }
    const res = await callPostingRpc("submit_sales_request", { p_request: requestId, p_user: user.id });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, companyId: rq.company_id, branchId: rq.branch_id, action: "sales_request.submit", resourceType: "sales_request", resourceId: requestId });
      refresh(`/sales/requests/${requestId}`);
    }
    return { ...res, id: requestId };
  } catch (e) { return fail(e); }
}

async function fundsOnRequest(admin: Admin, requestId: string): Promise<number> {
  const [{ data: p }, { data: f }] = await Promise.all([
    admin.from("sales_request_payments").select("amount").eq("request_id", requestId),
    admin.from("sales_request_funds").select("amount").eq("request_id", requestId),
  ]);
  return round2([...(p ?? []), ...(f ?? [])].reduce((s, r) => s + Number(r.amount), 0));
}

/**
 * The ONE approval: the manager confirms each payment against the bank or
 * collection record. The database records the receipts once, commits the
 * funds, reserves stock and creates the approved Sales Order atomically.
 */
export async function approveSalesRequest(requestId: string, verifications: { payment_id: string; basis: string }[], note: string, idemKey: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "sales.approve");
    const admin = createAdminClient();
    const { data: rq } = await admin.from("sales_requests").select("company_id, branch_id, customer_id").eq("id", requestId).maybeSingle();
    if (!rq) return { ok: false, error: "Request not found." };
    assertBranchAccess(user, rq.branch_id);
    const res = await callPostingRpc("approve_sales_request", {
      p_request: requestId, p_user: user.id, p_idem: `approve:${requestId}:${idemKey || randomUUID()}`, p_verifications: verifications, p_note: note || null,
    });
    if (!res.ok || !res.id) return res;
    await earnNextOrderRewards(admin, res.id, rq.company_id, rq.customer_id);
    await writeAuditLog({ userId: user.id, companyId: rq.company_id, branchId: rq.branch_id, action: "sales_request.approve", resourceType: "sales_order", resourceId: res.id });
    refresh(`/sales/requests/${requestId}`, `/sales/orders/${res.id}`, "/inventory");
    return res;
  } catch (e) { return fail(e); }
}

/** Free goods an approved order earns for the customer's next order. */
async function earnNextOrderRewards(admin: Admin, orderId: string, companyId: string, customerId: string) {
  const { data: cust } = await admin.from("customers").select("is_protected").eq("id", customerId).maybeSingle();
  if (!cust || cust.is_protected) return;
  const { data: lines } = await admin.from("sales_order_lines").select("product_id, quantity").eq("order_id", orderId).eq("is_free", false);
  const bought = new Map<string, number>();
  for (const l of lines ?? []) bought.set(l.product_id, (bought.get(l.product_id) ?? 0) + Number(l.quantity));
  if (!bought.size) return;
  const { data: rules } = await admin.from("sales_promotions").select(RULE_COLS)
    .eq("company_id", companyId).eq("is_active", true).eq("reward_timing", "next_order").in("product_id", [...bought.keys()]);
  const earned = earnedFreeGoods((rules ?? []).map(toRule), bought, todayISO(), false);
  if (!earned.length) return;
  await admin.from("promotion_rewards").upsert(earned.map((e) => ({
    company_id: companyId, promotion_id: e.promotion.id, customer_id: customerId, product_id: e.promotion.product_id,
    quantity: e.quantity, earned_order_id: orderId,
  })), { onConflict: "promotion_id,earned_order_id", ignoreDuplicates: true });
}

export async function decideSalesRequest(requestId: string, decision: "return" | "reject", reason: string): Promise<RpcResult> {
  return rpcAction("sales.approve", "decide_sales_request", { p_request: requestId, p_decision: decision, p_reason: reason },
    `sales_request.${decision}`, "sales_request", requestId, [`/sales/requests/${requestId}`], reason);
}

/* ------------------------------------------------------------------ trucks */

export interface ShipmentHeaderInput {
  dispatch_location?: string; consignee_name?: string; consignee_phone?: string; destination?: string;
  transporter_name?: string; transporter_contact?: string; driver_name?: string; driver_phone?: string; driver_licence?: string;
  vehicle_registration?: string; trailer_registration?: string;
  collector_name?: string; collector_phone?: string; collector_id_number?: string;
  planned_loading_date?: string; planned_dispatch_date?: string;
}

export async function createShipment(orderId: string, requestKey: string, header: ShipmentHeaderInput, lines: { order_line_id: string; qty: number }[]): Promise<RpcResult> {
  return rpcAction("sales.fulfil", "create_sales_shipment",
    { p_order: orderId, p_request_key: requestKey, p_header: header, p_lines: lines.filter((l) => l.qty > 0) },
    "sales_shipment.create", "sales_order", orderId, [`/sales/orders/${orderId}`]);
}
export async function issueLoadingOrder(shipmentId: string): Promise<RpcResult> {
  const r = await rpcAction("sales.fulfil", "issue_loading_order", { p_shipment: shipmentId }, "sales_shipment.loading_order", "sales_shipment", shipmentId, [`/sales/shipments/${shipmentId}`]);
  return { ...r, id: shipmentId };
}
export async function recordLoading(shipmentId: string, lines: { shipment_line_id: string; qty_loaded: number; batch?: string }[]): Promise<RpcResult> {
  return rpcAction("sales.fulfil", "record_shipment_loading", { p_shipment: shipmentId, p_lines: lines }, "sales_shipment.loaded", "sales_shipment", shipmentId, [`/sales/shipments/${shipmentId}`]);
}
export async function dispatchShipment(shipmentId: string, checked: boolean, idemKey: string): Promise<RpcResult> {
  return rpcAction("sales.fulfil", "dispatch_sales_shipment",
    { p_shipment: shipmentId, p_idem: `dispatch:${shipmentId}:${idemKey || randomUUID()}`, p_checked: checked },
    "sales_shipment.dispatch", "sales_shipment", shipmentId, [`/sales/shipments/${shipmentId}`, "/sales/history", "/inventory", "/dashboard"]);
}
export async function cancelShipment(shipmentId: string, reason: string): Promise<RpcResult> {
  return rpcAction("sales.fulfil", "cancel_sales_shipment", { p_shipment: shipmentId, p_reason: reason }, "sales_shipment.cancel", "sales_shipment", shipmentId, [`/sales/shipments/${shipmentId}`], reason);
}
export async function recordDelivery(shipmentId: string, data: {
  recipient_name: string; recipient_phone?: string; notes?: string; delivered_at?: string;
  lines: { shipment_line_id: string; qty_accepted: number; qty_short: number; qty_damaged: number }[];
}): Promise<RpcResult> {
  return rpcAction("sales.fulfil", "record_shipment_delivery", { p_shipment: shipmentId, p_data: data }, "sales_shipment.delivered", "sales_shipment", shipmentId, [`/sales/shipments/${shipmentId}`]);
}

/* ------------------------------------------------------------------ exceptions, funds, amendments */

export async function resolveException(exceptionId: string, resolution: string): Promise<RpcResult> {
  return rpcAction("sales.approve", "resolve_sales_exception", { p_exception: exceptionId, p_resolution: resolution }, "sales_exception.resolve", "sales_exception", exceptionId, [], resolution);
}
export async function commitOrderFunds(orderId: string, funds: RequestFundInput[]): Promise<RpcResult> {
  return rpcAction("sales.approve", "commit_order_funds", { p_order: orderId, p_funds: funds }, "sales_order.commit_funds", "sales_order", orderId, [`/sales/orders/${orderId}`]);
}
export async function reverseAdvance(receiptId: string, reason: string): Promise<RpcResult> {
  return rpcAction("sales.approve", "reverse_customer_advance", { p_receipt: receiptId, p_reason: reason }, "customer_advance.reverse", "customer_receipt", receiptId, ["/sales/customer-payments", "/sales/history"], reason);
}
export async function refundAdvance(receiptId: string, accountId: string, amount: number, reference: string, reason: string): Promise<RpcResult> {
  return rpcAction("sales.approve", "refund_customer_advance",
    { p_receipt: receiptId, p_account: accountId, p_amount: amount, p_reference: reference, p_reason: reason },
    "customer_advance.refund", "customer_receipt", receiptId, ["/sales/customer-payments"], reason);
}
export async function requestAmendment(orderId: string, kind: "change_lines" | "delivery" | "cancel_remaining", changes: Record<string, unknown>, reason: string): Promise<RpcResult> {
  try {
    // Added products carry the trusted product and tax snapshot.
    if (kind === "change_lines" && Array.isArray(changes.add) && changes.add.length) {
      const user = await assertActiveUser();
      const ctx = await getActiveContext();
      const admin = createAdminClient();
      const add = changes.add as { product_id: string; quantity: number; unit_price: number }[];
      const { data: prods } = await admin.from("products").select("id, name, selling_price, tax_code_id, track_inventory, company_id, tax:tax_codes(id, name, tax_type, rate, is_inclusive)").in("id", add.map((a) => a.product_id));
      changes = { ...changes, add: add.map((a) => {
        const p = (prods ?? []).find((x) => x.id === a.product_id) as unknown as { id: string; name: string; selling_price: number; track_inventory: boolean; company_id: string;
          tax: { id: string; name: string; tax_type: string; rate: number; is_inclusive: boolean } | null } | undefined;
        if (!p || p.company_id !== ctx.companyId) throw new Error("A selected product is invalid.");
        if (round2(a.unit_price) !== round2(Number(p.selling_price)) && !userHasPermission(user, "sales.override_price")) throw new Error("You are not allowed to change the selling price.");
        return { product_id: p.id, description: p.name, quantity: a.quantity, unit_price: a.unit_price, original_price: Number(p.selling_price),
          tax_code_id: p.tax?.id ?? null, tax_rate: p.tax ? Number(p.tax.rate) : 0, tax_type: p.tax?.tax_type ?? null, tax_name: p.tax?.name ?? null,
          tax_inclusive: p.tax?.is_inclusive ?? false, track_inventory: p.track_inventory };
      }) };
    }
    return await rpcAction("sales.fulfil", "request_sales_amendment", { p_order: orderId, p_kind: kind, p_changes: changes, p_reason: reason },
      "sales_order.amendment_request", "sales_order", orderId, [`/sales/orders/${orderId}`], reason);
  } catch (e) { return fail(e); }
}
export async function approveAmendment(amendmentId: string, funds: RequestFundInput[]): Promise<RpcResult> {
  return rpcAction("sales.approve", "approve_sales_amendment", { p_amendment: amendmentId, p_funds: funds }, "sales_order.amendment_approve", "sales_amendment", amendmentId, []);
}
export async function rejectAmendment(amendmentId: string, reason: string): Promise<RpcResult> {
  return rpcAction("sales.approve", "reject_sales_amendment", { p_amendment: amendmentId, p_reason: reason }, "sales_order.amendment_reject", "sales_amendment", amendmentId, [], reason);
}

/** Checks the permission, runs one workflow function as the user and records the audit entry. */
async function rpcAction(permission: string, fn: string, args: Record<string, unknown>, action: string, resourceType: string, resourceId: string,
  paths: string[], reason?: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, permission);
    const ctx = await getActiveContext();
    const res = await callPostingRpc(fn, { ...args, p_user: user.id });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action, resourceType, resourceId, reason });
      refresh(...paths);
    }
    return res;
  } catch (e) { return fail(e); }
}

/* ------------------------------------------------------------------ customers */

export interface QuickCustomerInput { branchId: string; name: string; phone: string; email?: string; tin?: string; vat?: string; address?: string; type?: string }

/** Sales Officer adds a customer missing from the list; the database refuses duplicates (name, phone, TIN, email). */
export async function createCustomerQuick(input: QuickCustomerInput): Promise<RpcResult & { customer?: { id: string; code: string; name: string } }> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "sales.create");
    const ctx = await getActiveContext();
    assertBranchAccess(user, input.branchId);
    const res = await callPostingRpc("create_customer_quick", {
      p_company: ctx.companyId, p_branch: input.branchId, p_user: user.id, p_name: input.name, p_phone: input.phone,
      p_email: input.email ?? null, p_tin: input.tin ?? null, p_vat: input.vat ?? null, p_address: input.address ?? null, p_type: input.type ?? null,
    });
    if (!res.ok || !res.id) {
      // A unique index can also catch a near-simultaneous duplicate.
      if (/customers_unique_/.test(res.error ?? "")) return { ok: false, error: "This customer already exists. Select it from the list." };
      return res;
    }
    const admin = createAdminClient();
    const { data: c } = await admin.from("customers").select("id, code, name").eq("id", res.id).single();
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: input.branchId, action: "customer.create", resourceType: "customer", resourceId: res.id });
    revalidatePath("/sales/new");
    return { ok: true, id: res.id, customer: c ?? undefined };
  } catch (e) { return fail(e); }
}
