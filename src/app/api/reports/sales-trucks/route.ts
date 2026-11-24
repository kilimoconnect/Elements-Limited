import { assertActiveUser } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { getActiveContext } from "@/lib/context";
import { writeAuditLog } from "@/lib/audit";
import { truckSales, truckTotals, truckFiltersFrom, TRUCK_SALE_STATUS } from "@/lib/reports/sales-trucks";
import { companyFor, fmtDay, fmtDayTime, fmtMoney, fmtNum, pdfReportResponse, xlsxResponse } from "@/lib/reports/export";
import { todayISO } from "@/lib/format";

/** GET the Sales by truck report as Excel (?format=xlsx) or PDF (?format=pdf), with the page's filters. */
export async function GET(req: Request) {
  let user;
  try { user = await assertActiveUser(); } catch { return new Response("Not signed in.", { status: 401 }); }
  if (!userHasPermission(user, "sales.view")) return new Response("Not allowed.", { status: 403 });
  const ctx = await getActiveContext();
  const url = new URL(req.url);
  const today = todayISO();
  const f = truckFiltersFrom(url.searchParams, { start: `${today.slice(0, 7)}-01`, end: today });
  const rows = await truckSales(ctx.companyId, ctx.user.isOwner ? null : ctx.user.branchIds, f);
  const t = truckTotals(rows);
  const branch = f.branch ? ctx.branches.find((b) => b.id === f.branch)?.name : "";
  const subtitle = [`${fmtDay(f.start)} – ${fmtDay(f.end)}`, branch, f.status && TRUCK_SALE_STATUS[f.status], f.q && `"${f.q}"`].filter(Boolean).join(" · ");
  const name = `sales-by-truck-${f.start}-${f.end}`;
  const format = url.searchParams.get("format");
  await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: `report.sales_trucks_${format === "pdf" ? "pdf" : "xlsx"}`, resourceType: "report", newValues: { ...f, rows: rows.length } });
  const statusLabel = (s: string) => TRUCK_SALE_STATUS[s] ?? s;

  if (format === "pdf") {
    return pdfReportResponse(name, await companyFor(ctx.companyId), "Sales by Truck", subtitle,
      [["Trucks", `${t.trucks}${t.voided ? ` (+${t.voided} voided)` : ""}`], ["Quantity", fmtNum(t.quantity)], ["Sales value (TZS)", fmtMoney(t.total)], ["Paid (TZS)", fmtMoney(t.paid)]],
      [{ h: "Dispatched", w: 56 }, { h: "Truck / driver", w: 88 }, { h: "Customer / order", w: 76 }, { h: "Branch", w: 58 }, { h: "Invoice / DN", w: 80 },
        { h: "Cargo", w: 70 }, { h: "Qty", w: 32, right: true }, { h: "Value (TZS)", w: 66, right: true }, { h: "Status", w: 58 }],
      rows.map((r) => [
        r.dispatchedAt ? `${fmtDay(r.dispatchedAt)}\n${fmtDayTime(r.dispatchedAt).slice(-5)}` : "",
        [r.truck, [r.vehicle, r.trailer].filter(Boolean).join(" / "), r.driver, r.driverPhone].filter(Boolean).join("\n"),
        `${r.customer}\n${r.order}`, r.branch, [r.invoice, r.deliveryNote].filter(Boolean).join("\n"),
        r.lines.map((l) => `${fmtNum(l.qty)} ${l.unit} ${l.product}`).join("\n"),
        r.status === "voided" ? "-" : fmtNum(r.quantity), r.status === "voided" ? "-" : fmtMoney(r.total),
        [statusLabel(r.status), r.status !== "voided" ? r.receivedBy : r.voidReason].filter(Boolean).join("\n"),
      ]),
      ["Total", `${t.trucks} trucks`, "", "", "", "", fmtNum(t.quantity), fmtMoney(t.total), ""]);
  }

  return xlsxResponse(name, "Sales by Truck", subtitle, [
    {
      name: "Trucks",
      columns: [
        { key: "dispatched", header: "Dispatched", type: "datetime" }, { key: "truck", header: "Truck" }, { key: "status", header: "Status", width: 12 },
        { key: "mode", header: "Fulfilment", width: 12 }, { key: "branch", header: "Branch" }, { key: "customerCode", header: "Customer code", width: 13 },
        { key: "customer", header: "Customer", width: 30 }, { key: "order", header: "Sales order", width: 16 }, { key: "vehicle", header: "Truck registration", width: 15 },
        { key: "trailer", header: "Trailer", width: 12 }, { key: "driver", header: "Driver", width: 22 }, { key: "driverPhone", header: "Driver phone", width: 14 },
        { key: "loadingOrder", header: "Loading order", width: 16 }, { key: "deliveryNote", header: "Delivery note", width: 16 }, { key: "invoice", header: "Invoice", width: 16 },
        { key: "cargo", header: "Cargo", width: 40 }, { key: "quantity", header: "Quantity", type: "number" },
        { key: "net", header: "Net (TZS)", type: "money" }, { key: "vat", header: "VAT (TZS)", type: "money" }, { key: "total", header: "Total (TZS)", type: "money" },
        { key: "paid", header: "Paid (TZS)", type: "money" }, { key: "outstanding", header: "Outstanding (TZS)", type: "money" },
        { key: "delivered", header: "Collected / delivered", type: "datetime" }, { key: "receivedBy", header: "Received by", width: 20 },
        { key: "destination", header: "Destination", width: 20 }, { key: "voidReason", header: "Void reason", width: 24 },
      ],
      rows: rows.map((r) => ({
        dispatched: r.dispatchedAt, truck: r.truck, status: statusLabel(r.status), mode: r.mode === "delivery" ? "Delivery" : "Collection", branch: r.branch,
        customerCode: r.customerCode, customer: r.customer, order: r.order, vehicle: r.vehicle, trailer: r.trailer, driver: r.driver, driverPhone: r.driverPhone,
        loadingOrder: r.loadingOrder, deliveryNote: r.deliveryNote, invoice: r.invoice, cargo: r.lines.map((l) => `${fmtNum(l.qty)} ${l.unit} ${l.product}`).join("; "),
        quantity: r.quantity, net: r.net, vat: r.vat, total: r.total, paid: r.paid, outstanding: r.outstanding,
        delivered: r.deliveredAt, receivedBy: r.receivedBy, destination: r.destination, voidReason: r.voidReason,
      })),
      totals: { dispatched: "Total", truck: `${t.trucks} trucks`, quantity: t.quantity, net: t.net, vat: t.vat, total: t.total, paid: t.paid, outstanding: t.outstanding },
    },
    {
      name: "Products",
      columns: [
        { key: "dispatched", header: "Dispatched", type: "datetime" }, { key: "truck", header: "Truck" }, { key: "status", header: "Status", width: 12 },
        { key: "customer", header: "Customer", width: 30 }, { key: "order", header: "Sales order", width: 16 }, { key: "invoice", header: "Invoice", width: 16 },
        { key: "vehicle", header: "Truck registration", width: 15 }, { key: "sku", header: "SKU", width: 12 }, { key: "product", header: "Product", width: 36 },
        { key: "unit", header: "Unit", width: 8 }, { key: "qty", header: "Quantity", type: "number" }, { key: "unitPrice", header: "Unit price (TZS)", type: "money" },
        { key: "value", header: "Value at price (TZS)", type: "money" }, { key: "accepted", header: "Accepted", type: "number" },
        { key: "short", header: "Short", type: "number" }, { key: "damaged", header: "Damaged", type: "number" },
      ],
      rows: rows.flatMap((r) => r.lines.map((l) => ({
        dispatched: r.dispatchedAt, truck: r.truck, status: statusLabel(r.status), customer: r.customer, order: r.order, invoice: r.invoice, vehicle: r.vehicle,
        sku: l.sku, product: l.product, unit: l.unit, qty: l.qty, unitPrice: l.unitPrice, value: Math.round(l.qty * l.unitPrice * 100) / 100,
        accepted: l.accepted, short: l.short || null, damaged: l.damaged || null,
      }))),
    },
  ]);
}
