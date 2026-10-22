"use server";

import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission, assertBranchAccess } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { callPostingRpc, type RpcResult } from "@/lib/rpc";
import { round2 } from "@/lib/sales/calc";
import { validateRate } from "@/lib/fx/rates";

/* -------------------------------- guards -------------------------------- */
async function guard(permission: string) {
  const user = await assertActiveUser();
  assertPermission(user, permission);
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "imports"))) throw new Error("Importation is not enabled.");
  return { user, ctx, admin: createAdminClient() };
}
const fail = (e: unknown): RpcResult => ({ ok: false, error: e instanceof Error ? e.message : "Failed." });
function revalidateShipment(id?: string) {
  ["/imports", "/imports/cost-invoices", "/inventory", "/dashboard"].forEach((p) => revalidatePath(p));
  if (id) revalidatePath(`/imports/${id}`);
}
async function loadShipment(admin: ReturnType<typeof createAdminClient>, id: string, companyId: string) {
  const { data } = await admin.from("import_shipments").select("*").eq("id", id).maybeSingle();
  if (!data || data.company_id !== companyId) throw new Error("Shipment not found.");
  return data as { id: string; company_id: string; branch_id: string; supplier_id: string; currency_code: string; logistics_status: string; cost_status: string; document_number: string };
}

/* ------------------------------- shipments ------------------------------ */
export interface ShipmentLineInput {
  product_id: string;
  /** Net weight in kg (the form converts MT x 1000). */
  net_kg: number;
  /** Units for non-bulk products; bulk products use kg. */
  quantity?: number;
  shipped_kg?: number | null;
  /** Expected goods value in the shipment currency. */
  goods_value: number;
  volume_m3?: number | null;
  batch_reference?: string;
}
export interface ShipmentInput {
  shipmentId?: string;
  branchId: string;
  supplierId: string;
  reference?: string;
  billOfLading?: string;
  vessel?: string;
  containerRefs?: string;
  originCountry?: string;
  originPort?: string;
  dischargePort?: string;
  incoterm: string;
  namedPlace: string;
  goodsIncludesFreight: boolean;
  goodsIncludesInsurance: boolean;
  currencyCode: string;
  planningRate?: number | null;
  ownershipEvent: "bill_of_lading" | "arrival" | "receipt";
  eta?: string | null;
  notes?: string;
  lines: ShipmentLineInput[];
}

export async function saveShipment(input: ShipmentInput): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await guard(input.shipmentId ? "imports.edit_draft" : "imports.create");
    assertBranchAccess(user, input.branchId);
    if (!input.supplierId) return { ok: false, error: "Select the supplier." };
    if (!input.namedPlace?.trim()) return { ok: false, error: "Enter the named place for the delivery terms." };
    if (input.lines.length === 0) return { ok: false, error: "Add at least one product line." };
    if (input.currencyCode !== "TZS") {
      if (!(await isFeatureEnabled(ctx.companyId, "fx_settlement"))) return { ok: false, error: "Foreign-currency purchasing is not enabled." };
      if (input.planningRate != null && !(input.planningRate > 0)) return { ok: false, error: "Planning rate must be positive." };
    }
    const { data: products } = await admin.from("products").select("id, company_id, stock_role, name").in("id", input.lines.map((l) => l.product_id));
    const pMap = new Map((products ?? []).map((p) => [p.id, p]));
    const lineRows = input.lines.map((l, i) => {
      const p = pMap.get(l.product_id);
      if (!p || p.company_id !== ctx.companyId) throw new Error("A product is invalid.");
      if (!(l.net_kg > 0)) throw new Error(`Enter the net weight for ${p.name}.`);
      if (!(l.goods_value >= 0)) throw new Error(`Enter the goods value for ${p.name}.`);
      const qty = p.stock_role === "bulk" ? l.net_kg : Number(l.quantity ?? 0);
      if (!(qty > 0)) throw new Error(`Enter the quantity for ${p.name}.`);
      return {
        company_id: ctx.companyId, product_id: l.product_id, quantity: qty, net_kg: l.net_kg,
        shipped_kg: l.shipped_kg && l.shipped_kg > 0 ? l.shipped_kg : null, fc_amount: round2(l.goods_value),
        volume_m3: l.volume_m3 && l.volume_m3 > 0 ? l.volume_m3 : null, batch_reference: l.batch_reference || null, line_no: i + 1,
      };
    });
    const header = {
      company_id: ctx.companyId, branch_id: input.branchId, supplier_id: input.supplierId,
      reference: input.reference || null, bill_of_lading: input.billOfLading || null, vessel: input.vessel || null,
      container_refs: input.containerRefs || null, origin_country: input.originCountry || null, origin_port: input.originPort || null,
      discharge_port: input.dischargePort || null, incoterm: input.incoterm, named_place: input.namedPlace.trim(),
      goods_includes_freight: input.goodsIncludesFreight, goods_includes_insurance: input.goodsIncludesInsurance,
      currency_code: input.currencyCode, planning_rate: input.currencyCode === "TZS" ? null : input.planningRate ?? null,
      ownership_event: input.ownershipEvent, eta: input.eta || null, notes: input.notes || null, updated_by: user.id,
    };
    let id = input.shipmentId ?? null;
    if (id) {
      const sh = await loadShipment(admin, id, ctx.companyId);
      if (!["draft", "ready"].includes(sh.logistics_status)) return { ok: false, error: "Only draft or ready shipments can be edited." };
      const { count } = await admin.from("import_shipment_ledger").select("id", { count: "exact", head: true }).eq("shipment_id", id);
      if ((count ?? 0) > 0) return { ok: false, error: "This shipment has postings; its lines can no longer change." };
      const { error } = await admin.from("import_shipments").update(header).eq("id", id);
      if (error) return { ok: false, error: error.message };
      const { error: delErr } = await admin.from("import_shipment_lines").delete().eq("shipment_id", id);
      if (delErr) return { ok: false, error: "Lines are referenced by invoices or costs; edit those first." };
    } else {
      const { data, error } = await admin.from("import_shipments").insert({ ...header, created_by: user.id }).select("id").single();
      if (error) return { ok: false, error: error.message };
      id = data.id;
    }
    const { error: lErr } = await admin.from("import_shipment_lines").insert(lineRows.map((r) => ({ ...r, shipment_id: id })));
    if (lErr) return { ok: false, error: lErr.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: input.branchId, action: input.shipmentId ? "import.shipment_edit" : "import.shipment_create", resourceType: "import_shipment", resourceId: id! });
    revalidateShipment(id!);
    return { ok: true, id: id! };
  } catch (e) { return fail(e); }
}

export async function setShipmentStatus(id: string, status: "ready" | "dispatched" | "cancelled", date?: string): Promise<RpcResult> {
  try {
    const { user, ctx } = await guard("imports.edit_draft");
    const res = await callPostingRpc("set_import_shipment_status", { p_id: id, p_status: status, p_date: date || null, p_user: user.id });
    if (res.ok) { await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: `import.shipment_${status}`, resourceType: "import_shipment", resourceId: id }); revalidateShipment(id); }
    return res;
  } catch (e) { return fail(e); }
}

export async function recogniseOwnership(id: string, date: string, rate?: number | null): Promise<RpcResult> {
  try {
    const { user, ctx } = await guard("imports.post");
    const res = await callPostingRpc("recognise_import_ownership", {
      p_shipment: id, p_date: date, p_rate: rate ?? null, p_user: user.id, p_idem: `recognise_import_ownership:${id}`,
    });
    if (res.ok) { await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "import.ownership", resourceType: "import_shipment", resourceId: id, newValues: { date, rate } }); revalidateShipment(id); }
    return res;
  } catch (e) { return fail(e); }
}

/* ------------------------------ cost sources ---------------------------- */
export async function addCostSource(input: {
  shipmentId: string; categoryId: string; description?: string; estimatedAmount: number; supplierId?: string | null;
  allocationBasis?: string | null; allocationTargets?: { id: string; amount?: number; percent?: number }[] | null;
}): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await guard("imports.edit_draft");
    const sh = await loadShipment(admin, input.shipmentId, ctx.companyId);
    if (sh.cost_status === "finalized") return { ok: false, error: "Shipment costs are finalised; record a cost invoice or credit note instead." };
    if (!(input.estimatedAmount >= 0)) return { ok: false, error: "Estimate cannot be negative." };
    const { data, error } = await admin.from("cost_sources").insert({
      company_id: ctx.companyId, owner_type: "import_shipment", import_shipment_id: sh.id, cost_category_id: input.categoryId,
      description: input.description || null, estimated_amount: round2(input.estimatedAmount), supplier_id: input.supplierId || null,
      allocation_basis: input.allocationBasis || null, allocation_targets: input.allocationTargets ?? null,
      created_by: user.id, updated_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message.replace(/^.*?: /, "") };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "import.cost_add", resourceType: "import_shipment", resourceId: sh.id, newValues: { cost_source_id: data.id } });
    revalidateShipment(sh.id);
    return { ok: true, id: data.id };
  } catch (e) { return fail(e); }
}

export async function voidCostEstimate(sourceId: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await guard("imports.edit_draft");
    const { data: s } = await admin.from("cost_sources").select("id, company_id, status, import_shipment_id").eq("id", sourceId).maybeSingle();
    if (!s || s.company_id !== ctx.companyId) return { ok: false, error: "Cost not found." };
    if (s.status !== "estimated") return { ok: false, error: "Only planning estimates can be voided; accrued or invoiced costs are corrected with credit notes." };
    const { error } = await admin.from("cost_sources").update({ status: "voided", updated_by: user.id }).eq("id", sourceId).eq("status", "estimated");
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "import.cost_void_estimate", resourceType: "cost_source", resourceId: sourceId });
    revalidateShipment(s.import_shipment_id);
    return { ok: true, id: sourceId };
  } catch (e) { return fail(e); }
}

export async function accrueCost(sourceId: string, amount: number, date: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await guard("imports.post");
    const { data: s } = await admin.from("cost_sources").select("company_id, import_shipment_id").eq("id", sourceId).maybeSingle();
    if (!s || s.company_id !== ctx.companyId) return { ok: false, error: "Cost not found." };
    const res = await callPostingRpc("accrue_import_cost", { p_source: sourceId, p_amount: round2(amount), p_date: date, p_user: user.id, p_idem: `accrue_import_cost:${sourceId}` });
    if (res.ok) { await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "import.cost_accrue", resourceType: "cost_source", resourceId: sourceId, newValues: { amount, date } }); revalidateShipment(s.import_shipment_id); }
    return res;
  } catch (e) { return fail(e); }
}

/* ------------------------------ goods invoice --------------------------- */
export async function createAndPostGoodsInvoice(input: {
  shipmentId: string; documentDate: string; supplierInvoiceNumber: string; supplierInvoiceDate?: string | null; dueDate?: string | null;
  exchangeRate?: number; rateSource?: "manual" | "rate_table"; rateReference?: string;
  lines: { shipment_line_id: string; quantity: number; unit_price: number; tax_code_id?: string | null }[];
}): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await guard("imports.post");
    const sh = await loadShipment(admin, input.shipmentId, ctx.companyId);
    assertBranchAccess(user, sh.branch_id);
    if (!input.supplierInvoiceNumber?.trim()) return { ok: false, error: "Enter the supplier invoice number." };
    const lines = input.lines.filter((l) => l.quantity > 0);
    if (lines.length === 0) return { ok: false, error: "Enter at least one invoiced quantity." };
    const isFc = sh.currency_code !== "TZS";
    let rate = 1;
    if (isFc) {
      assertPermission(user, "fx.enter_rate");
      const r = await validateRate(ctx.companyId, sh.currency_code, input.documentDate, input.exchangeRate, input.rateSource ?? null);
      if (!r.ok) return { ok: false, error: r.error };
      rate = r.rate;
    }
    const { data: shLines } = await admin.from("import_shipment_lines").select("id, product_id, shipment_id, tax_code_id").in("id", lines.map((l) => l.shipment_line_id));
    const slMap = new Map((shLines ?? []).map((l) => [l.id, l]));
    const taxIds = Array.from(new Set(lines.map((l) => l.tax_code_id).filter(Boolean) as string[]));
    const { data: taxes } = taxIds.length ? await admin.from("tax_codes").select("id, company_id, name, tax_type, rate, is_inclusive, is_recoverable").in("id", taxIds) : { data: [] };
    const tMap = new Map((taxes ?? []).map((t) => [t.id, t]));
    const { data: pur, error } = await admin.from("purchases").insert({
      company_id: ctx.companyId, branch_id: sh.branch_id, supplier_id: sh.supplier_id, document_date: input.documentDate,
      supplier_invoice_number: input.supplierInvoiceNumber.trim(), supplier_invoice_date: input.supplierInvoiceDate || null,
      due_date: input.dueDate || null, import_shipment_id: sh.id, posting_mode: "invoice_only", currency_code: sh.currency_code,
      exchange_rate: rate, rate_source: isFc ? input.rateSource : null, rate_reference: isFc ? input.rateReference || null : null,
      is_credit: true, created_by: user.id, updated_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    const rows = lines.map((l, i) => {
      const sl = slMap.get(l.shipment_line_id);
      if (!sl || sl.shipment_id !== sh.id) throw new Error("Invoice line is not a line of this shipment.");
      const tc = l.tax_code_id ? tMap.get(l.tax_code_id) : null;
      if (tc && tc.company_id !== ctx.companyId) throw new Error("Tax code belongs to another company.");
      return {
        purchase_id: pur.id, product_id: sl.product_id, import_shipment_line_id: sl.id, quantity: l.quantity, unit_cost: round2(l.unit_price),
        tax_code_id: tc?.id ?? null, tax_rate: tc ? Number(tc.rate) : 0, tax_type: tc?.tax_type ?? null, tax_name: tc?.name ?? null,
        tax_inclusive: tc?.is_inclusive ?? false, is_recoverable: tc ? tc.is_recoverable : true, line_no: i + 1,
      };
    });
    const { error: lErr } = await admin.from("purchase_lines").insert(rows);
    if (lErr) { await admin.from("purchases").delete().eq("id", pur.id); return { ok: false, error: lErr.message }; }
    const res = await callPostingRpc("post_import_goods_invoice", { p_id: pur.id, p_user: user.id, p_idem: `post_import_goods_invoice:${pur.id}` });
    if (!res.ok) { await admin.from("purchases").delete().eq("id", pur.id); return res; }
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: sh.branch_id, action: "import.goods_invoice_post", resourceType: "purchase", resourceId: pur.id });
    revalidateShipment(sh.id); revalidatePath("/purchases/history");
    return { ok: true, id: pur.id };
  } catch (e) { return fail(e); }
}

/* -------------------------------- receipts ------------------------------ */
export async function createAndPostImportReceipt(input: {
  shipmentId: string; branchId: string; receiptDate: string; notes?: string; goodsAccrualRate?: number | null; requestId: string;
  lines: { shipment_line_id: string; net_kg: number; quantity?: number; weighbridge_ref?: string; batch_code?: string;
    is_final: boolean; resolution?: "normal_loss" | "write_off" | "claim" | null }[];
}): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await guard("imports.receive");
    const sh = await loadShipment(admin, input.shipmentId, ctx.companyId);
    assertBranchAccess(user, input.branchId);
    const { data: branch } = await admin.from("branches").select("company_id").eq("id", input.branchId).maybeSingle();
    if (!branch || branch.company_id !== ctx.companyId) return { ok: false, error: "Receipt location is not a branch of this company." };
    if (!input.requestId || input.requestId.length < 16) return { ok: false, error: "Missing request id; reload the page." };
    const { data: prior } = await admin.from("import_receipts").select("id, document_status").eq("company_id", ctx.companyId).eq("client_request_id", input.requestId).maybeSingle();
    if (prior?.document_status === "posted") return { ok: true, id: prior.id };
    if (prior) await admin.from("import_receipts").delete().eq("id", prior.id).eq("document_status", "draft");
    const lines = input.lines.filter((l) => l.net_kg > 0 || l.is_final);
    if (lines.length === 0) return { ok: false, error: "Enter the net kg received." };
    const { data: shLines } = await admin.from("import_shipment_lines").select("id, shipment_id, product:products(stock_role)").in("id", lines.map((l) => l.shipment_line_id));
    const slMap = new Map(((shLines ?? []) as unknown as { id: string; shipment_id: string; product: { stock_role: string } | null }[]).map((l) => [l.id, l]));
    const { data: rec, error } = await admin.from("import_receipts").insert({
      company_id: ctx.companyId, shipment_id: sh.id, branch_id: input.branchId, receipt_date: input.receiptDate, notes: input.notes || null,
      goods_accrual_rate: input.goodsAccrualRate ?? null, client_request_id: input.requestId, created_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    const rows = lines.map((l, i) => {
      const sl = slMap.get(l.shipment_line_id);
      if (!sl || sl.shipment_id !== sh.id) throw new Error("Receipt line is not a line of this shipment.");
      const bulk = sl.product?.stock_role === "bulk";
      return {
        company_id: ctx.companyId, receipt_id: rec.id, shipment_line_id: sl.id, net_kg_received: l.net_kg,
        quantity_received: bulk ? l.net_kg : Number(l.quantity ?? 0), weighbridge_ref: l.weighbridge_ref || null,
        batch_code: l.batch_code || null, is_final: l.is_final, resolution: l.resolution ?? null, line_no: i + 1,
      };
    });
    const { error: lErr } = await admin.from("import_receipt_lines").insert(rows);
    if (lErr) { await admin.from("import_receipts").delete().eq("id", rec.id); return { ok: false, error: lErr.message }; }
    const res = await callPostingRpc("post_import_receipt", { p_id: rec.id, p_user: user.id, p_idem: `post_import_receipt:${rec.id}` });
    if (!res.ok) { await admin.from("import_receipts").delete().eq("id", rec.id); return res; }
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: input.branchId, action: "import.receipt_post", resourceType: "import_receipt", resourceId: rec.id });
    revalidateShipment(sh.id);
    return { ok: true, id: rec.id };
  } catch (e) { return fail(e); }
}

/* ------------------------------ cost invoices --------------------------- */
export async function createAndPostCostInvoice(input: {
  branchId: string; supplierId: string; documentDate: string; supplierInvoiceNumber: string; dueDate?: string | null;
  kind: "invoice" | "credit_note"; creditedInvoiceId?: string | null; notes?: string; requestId: string;
  lines: { cost_category_id: string; cost_source_id?: string | null; description?: string; net_amount: number; tax_code_id?: string | null }[];
}): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await guard("cost_invoices.post");
    assertBranchAccess(user, input.branchId);
    if (!input.supplierInvoiceNumber?.trim()) return { ok: false, error: "Enter the supplier's document number." };
    const lines = input.lines.filter((l) => l.net_amount > 0);
    if (lines.length === 0) return { ok: false, error: "Add at least one line with an amount." };
    if (input.kind === "credit_note" && !input.creditedInvoiceId) return { ok: false, error: "Choose the invoice this credit note adjusts." };
    if (!input.requestId || input.requestId.length < 16) return { ok: false, error: "Missing request id; reload the page." };
    const { data: prior } = await admin.from("cost_invoices").select("id, document_status").eq("company_id", ctx.companyId)
      .eq("client_request_id", input.requestId).maybeSingle();
    if (prior?.document_status === "posted") return { ok: true, id: prior.id };
    if (prior) await admin.from("cost_invoices").delete().eq("id", prior.id).eq("document_status", "draft");
    const taxIds = Array.from(new Set(lines.map((l) => l.tax_code_id).filter(Boolean) as string[]));
    const { data: taxes } = taxIds.length ? await admin.from("tax_codes").select("id, company_id, rate, is_inclusive, is_recoverable").in("id", taxIds) : { data: [] };
    const tMap = new Map((taxes ?? []).map((t) => [t.id, t]));
    const { data: ci, error } = await admin.from("cost_invoices").insert({
      company_id: ctx.companyId, branch_id: input.branchId, supplier_id: input.supplierId, document_date: input.documentDate,
      supplier_invoice_number: input.supplierInvoiceNumber.trim(), due_date: input.dueDate || null, document_kind: input.kind,
      credited_invoice_id: input.kind === "credit_note" ? input.creditedInvoiceId : null,
      notes: input.notes || null, client_request_id: input.requestId, created_by: user.id, updated_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    const rows = lines.map((l, i) => {
      const tc = l.tax_code_id ? tMap.get(l.tax_code_id) : null;
      if (tc && tc.company_id !== ctx.companyId) throw new Error("Tax code belongs to another company.");
      const rate = tc ? Number(tc.rate) : 0;
      // Net amounts are entered exclusive of tax; tax is computed server-side from the line's tax code.
      const tax = round2(l.net_amount * rate / 100);
      return {
        company_id: ctx.companyId, cost_invoice_id: ci.id, cost_category_id: l.cost_category_id, cost_source_id: l.cost_source_id || null,
        description: l.description || null, net_amount: round2(l.net_amount), tax_code_id: tc?.id ?? null, tax_rate: rate,
        is_recoverable: tc ? tc.is_recoverable : true, tax_amount: tax, line_no: i + 1,
      };
    });
    const { error: lErr } = await admin.from("cost_invoice_lines").insert(rows);
    if (lErr) { await admin.from("cost_invoices").delete().eq("id", ci.id); return { ok: false, error: lErr.message }; }
    const res = await callPostingRpc("post_cost_invoice", { p_id: ci.id, p_user: user.id, p_idem: `post_cost_invoice:${ci.id}` });
    if (!res.ok) { await admin.from("cost_invoices").delete().eq("id", ci.id); return res; }
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: input.branchId, action: "import.cost_invoice_post", resourceType: "cost_invoice", resourceId: ci.id });
    revalidateShipment();
    const { data: ships } = await admin.from("cost_sources").select("import_shipment_id").in("id", lines.map((l) => l.cost_source_id).filter(Boolean) as string[]);
    for (const s of ships ?? []) if (s.import_shipment_id) revalidatePath(`/imports/${s.import_shipment_id}`);
    return { ok: true, id: ci.id };
  } catch (e) { return fail(e); }
}

/** Void a posted import goods invoice (unpaid, no credits or revaluations); the shipment line returns to its provisional value. */
export async function voidGoodsInvoice(purchaseId: string, reason: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin } = await guard("imports.void");
    if (!reason?.trim()) return { ok: false, error: "Enter the reason for the void." };
    const { data: p } = await admin.from("purchases").select("id, company_id, branch_id, import_shipment_id, posting_mode").eq("id", purchaseId).maybeSingle();
    if (!p || p.company_id !== ctx.companyId || p.posting_mode !== "invoice_only" || !p.import_shipment_id) return { ok: false, error: "Import goods invoice not found." };
    assertBranchAccess(user, p.branch_id);
    const res = await callPostingRpc("void_import_goods_invoice", { p_id: purchaseId, p_user: user.id, p_reason: reason.trim(), p_idem: `void_import_goods_invoice:${purchaseId}` });
    if (!res.ok) return res;
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: p.branch_id, action: "import.goods_invoice_void", resourceType: "purchase", resourceId: purchaseId, newValues: { reason: reason.trim() } });
    revalidateShipment(p.import_shipment_id);
    revalidatePath("/purchases"); revalidatePath(`/purchases/${purchaseId}`);
    return { ok: true, id: purchaseId };
  } catch (e) { return fail(e); }
}

/* ------------------------------- finalisation --------------------------- */
export async function finalizeShipment(id: string): Promise<RpcResult> {
  try {
    const { user, ctx } = await guard("imports.finalize_cost");
    const res = await callPostingRpc("finalize_import_shipment", { p_shipment: id, p_user: user.id, p_idem: `finalize_import_shipment:${id}` });
    if (res.ok) { await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "import.finalize", resourceType: "import_shipment", resourceId: id }); revalidateShipment(id); }
    return res;
  } catch (e) { return fail(e); }
}
