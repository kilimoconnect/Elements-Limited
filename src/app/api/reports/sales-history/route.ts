import { assertActiveUser } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { companyFor, fmtDay, fmtMoney, pdfReportResponse, xlsxResponse } from "@/lib/reports/export";

const STATUS: Record<string, string> = { draft: "Draft", pending_approval: "Pending approval", rejected: "Rejected", posted: "Posted", voided: "Voided" };
const PAY: Record<string, string> = { unpaid: "Unpaid", partially_paid: "Partial", paid: "Paid", refunded: "Refunded", partially_refunded: "Part. refunded" };
const N = (v: unknown) => Number(v ?? 0);

/** GET Sales History as Excel or PDF, with the list's filters (search, status, payment, branch); every page, not just the visible one. */
export async function GET(req: Request) {
  let user;
  try { user = await assertActiveUser(); } catch { return new Response("Not signed in.", { status: 401 }); }
  if (!userHasPermission(user, "sales.view")) return new Response("Not allowed.", { status: 403 });
  const ctx = await getActiveContext();
  const sp = new URL(req.url).searchParams;
  const q = (sp.get("q") ?? "").trim(), status = sp.get("status") ?? "", pay = sp.get("pay") ?? "", branch = sp.get("branch") ?? "", format = sp.get("format");

  let query = createAdminClient().from("sales")
    .select("id, document_number, document_date, net_total, tax_total, grand_total, amount_paid, outstanding, payment_status, document_status, approval_status, shipment_id, sales_order_id, customer:customers(code, name), branch:branches(name)")
    .eq("company_id", ctx.companyId).order("document_date", { ascending: false }).order("created_at", { ascending: false }).limit(5000);
  if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  if (branch) query = query.eq("branch_id", branch);
  if (status === "pending_approval" || status === "rejected") query = query.eq("document_status", "draft").eq("approval_status", status === "rejected" ? "rejected" : "pending");
  else if (status === "draft") query = query.eq("document_status", "draft").eq("approval_status", "not_submitted");
  else if (status) query = query.eq("document_status", status);
  if (pay) query = query.eq("payment_status", pay);
  if (q) query = query.ilike("document_number", `%${q}%`);
  const { data, error } = await query;
  if (error) return new Response(error.message, { status: 500 });
  // Truck and order of truck invoices (sales keep their ids without a foreign key).
  const raw = (data ?? []) as unknown as { shipment_id: string | null; sales_order_id: string | null }[];
  const shipIds = [...new Set(raw.map((r) => r.shipment_id).filter(Boolean))] as string[];
  const orderIds = [...new Set(raw.map((r) => r.sales_order_id).filter(Boolean))] as string[];
  const admin = createAdminClient();
  const [{ data: ships }, { data: orders }] = await Promise.all([
    shipIds.length ? admin.from("sales_shipments").select("id, document_number, vehicle_registration").in("id", shipIds) : Promise.resolve({ data: [] }),
    orderIds.length ? admin.from("sales_orders").select("id, document_number").in("id", orderIds) : Promise.resolve({ data: [] }),
  ]);
  const shipOf = new Map(((ships ?? []) as { id: string; document_number: string; vehicle_registration: string | null }[]).map((x) => [x.id, x]));
  const orderOf = new Map(((orders ?? []) as { id: string; document_number: string }[]).map((x) => [x.id, x]));
  type Row = { document_number: string | null; document_date: string; net_total: number; tax_total: number; grand_total: number; amount_paid: number; outstanding: number;
    payment_status: string; document_status: string; approval_status: string; customer: { code: string; name: string } | null; branch: { name: string } | null;
    shipment_id: string | null; sales_order_id: string | null;
    order?: { document_number: string } | null; shipment?: { document_number: string; vehicle_registration: string | null } | null };
  const rows = (data ?? [] as unknown[]).map((r) => {
    const x = r as unknown as Row;
    return { ...x, shipment: x.shipment_id ? shipOf.get(x.shipment_id) ?? null : null, order: x.sales_order_id ? orderOf.get(x.sales_order_id) ?? null : null };
  });
  const st = (r: Row) => (r.document_status !== "draft" ? r.document_status : r.approval_status === "pending" ? "pending_approval" : r.approval_status === "rejected" ? "rejected" : "draft");
  const live = rows.filter((r) => r.document_status === "posted");
  const sum = (k: "net_total" | "tax_total" | "grand_total" | "amount_paid" | "outstanding") => live.reduce((a, r) => a + N(r[k]), 0);
  const subtitle = [rows.length ? `${fmtDay(rows[rows.length - 1].document_date)} – ${fmtDay(rows[0].document_date)}` : "",
    branch && ctx.branches.find((b) => b.id === branch)?.name, status && STATUS[status], pay && PAY[pay], q && `"${q}"`].filter(Boolean).join(" · ") || "All sales";
  const name = `sales-history-${new Date().toISOString().slice(0, 10)}`;
  await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: `report.sales_history_${format === "pdf" ? "pdf" : "xlsx"}`, resourceType: "report", newValues: { q, status, pay, branch, rows: rows.length } });

  if (format === "pdf") {
    return pdfReportResponse(name, await companyFor(ctx.companyId), "Sales History", subtitle,
      [["Invoices", String(live.length)], ["Total (TZS)", fmtMoney(sum("grand_total"))], ["Paid (TZS)", fmtMoney(sum("amount_paid"))], ["Outstanding (TZS)", fmtMoney(sum("outstanding"))]],
      [{ h: "Date", w: 50 }, { h: "Invoice", w: 70 }, { h: "Customer", w: 110 }, { h: "Branch", w: 70 }, { h: "Truck / order", w: 75 },
        { h: "Total (TZS)", w: 70, right: true }, { h: "Outstanding", w: 64, right: true }, { h: "Payment / status", w: 60 }],
      rows.map((r) => {
        const voided = r.document_status === "voided";
        return [fmtDay(r.document_date), r.document_number ?? "draft", r.customer?.name ?? "", r.branch?.name ?? "",
          [r.shipment?.vehicle_registration, r.order?.document_number].filter(Boolean).join("\n"), fmtMoney(r.grand_total),
          voided ? "-" : fmtMoney(r.outstanding), [voided ? "" : PAY[r.payment_status] ?? r.payment_status, STATUS[st(r)] ?? st(r)].filter(Boolean).join("\n")];
      }),
      ["Total (posted)", `${live.length} invoices`, "", "", "", fmtMoney(sum("grand_total")), fmtMoney(sum("outstanding")), ""]);
  }
  return xlsxResponse(name, "Sales History", subtitle, [{
    name: "Sales",
    columns: [
      { key: "date", header: "Date", type: "date" }, { key: "doc", header: "Invoice", width: 18 }, { key: "status", header: "Status", width: 14 },
      { key: "customerCode", header: "Customer code", width: 13 }, { key: "customer", header: "Customer", width: 32 }, { key: "branch", header: "Branch", width: 24 },
      { key: "order", header: "Sales order", width: 16 }, { key: "truck", header: "Truck", width: 16 }, { key: "vehicle", header: "Truck registration", width: 15 },
      { key: "net", header: "Net (TZS)", type: "money" }, { key: "vat", header: "VAT (TZS)", type: "money" }, { key: "total", header: "Total (TZS)", type: "money" },
      { key: "paid", header: "Paid (TZS)", type: "money" }, { key: "outstanding", header: "Outstanding (TZS)", type: "money" }, { key: "payment", header: "Payment", width: 12 },
    ],
    rows: rows.map((r) => {
      const voided = r.document_status === "voided";
      return {
        date: r.document_date, doc: r.document_number ?? "draft", status: STATUS[st(r)] ?? st(r), customerCode: r.customer?.code, customer: r.customer?.name, branch: r.branch?.name,
        order: r.order?.document_number, truck: r.shipment?.document_number, vehicle: r.shipment?.vehicle_registration,
        net: N(r.net_total), vat: N(r.tax_total), total: N(r.grand_total), paid: voided ? null : N(r.amount_paid), outstanding: voided ? null : N(r.outstanding),
        payment: voided ? "" : PAY[r.payment_status] ?? r.payment_status,
      };
    }),
    totals: { date: "Total (posted)", doc: `${live.length} invoices`, net: sum("net_total"), vat: sum("tax_total"), total: sum("grand_total"), paid: sum("amount_paid"), outstanding: sum("outstanding") },
  }]);
}
