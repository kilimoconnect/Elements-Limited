"use server";

import ExcelJS from "exceljs";
import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveContext } from "@/lib/context";
import { writeAuditLog } from "@/lib/audit";
import { canUseLicenceNumber } from "@/lib/transfers/licence";
import { buildOrders, parseCsv, type ImportCheck, type ImportOrder, type RawImportRow } from "@/lib/transfers/bulk-import";
import { createTransferWithTrip, checkRecentTruckUse } from "@/lib/transfers/actions";

const MAX_BYTES = 5 * 1024 * 1024;

async function readFile(file: File): Promise<{ header: string[]; rows: RawImportRow[] }> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || file.type === "text/csv") {
    const all = parseCsv(await file.text());
    return { header: all[0] ?? [], rows: all.slice(1).map((values, i) => ({ row: i + 2, values })) };
  }
  if (!name.endsWith(".xlsx")) throw new Error("Upload the Excel template (.xlsx) or a CSV file.");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.getWorksheet("Transfer orders") ?? wb.worksheets.find((w) => w.state === "visible") ?? wb.worksheets[0];
  if (!ws) throw new Error("The file has no sheet.");
  const text = (row: ExcelJS.Row, n: number) => Array.from({ length: n }, (_, i) => {
    const c = row.getCell(i + 1);
    const v = c.value as unknown;
    if (typeof v === "number") return String(v);
    return (c.text ?? "").toString();
  });
  const head = ws.getRow(1);
  const width = Math.max(head.cellCount, 10);
  const header = text(head, width);
  const rows: RawImportRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) rows.push({ row: r, values: text(ws.getRow(r), width) });
  return { header, rows };
}

export type CheckResult = { ok: true; check: ImportCheck; totals: { orders: number; quantity: number } } | { ok: false; error: string };

/** Read the uploaded file and check every row: branches, products, quantities, stock at the sending branch, repeated trucks. Creates nothing. */
export async function checkTransferImport(form: FormData): Promise<CheckResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "inventory.transfer_create");
    const ctx = await getActiveContext();
    const source = String(form.get("sourceBranchId") ?? "");
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the file to import." };
    if (file.size > MAX_BYTES) return { ok: false, error: "The file is larger than 5 MB." };
    if (!user.isOwner && !user.branchIds.includes(source)) return { ok: false, error: "Choose a sending branch you work in." };
    const admin = createAdminClient();
    const [{ header, rows }, { data: branches }, { data: products }, { data: stock }] = await Promise.all([
      readFile(file),
      admin.from("branches").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true),
      admin.from("products").select("id, sku, name").eq("company_id", ctx.companyId).eq("is_active", true),
      admin.from("stock_balances").select("product_id, quantity").eq("company_id", ctx.companyId).eq("branch_id", source),
    ]);
    if (!(branches ?? []).some((b) => b.id === source)) return { ok: false, error: "Choose the sending branch." };
    if (rows.length > 2000) return { ok: false, error: "Import at most 2,000 rows at a time." };
    const check = buildOrders(rows, header, branches ?? [], products ?? [], source);

    // Enough stock at the sending branch for all trucks together.
    const onHand = new Map((stock ?? []).map((s) => [s.product_id, Number(s.quantity)]));
    const need = new Map<string, { qty: number; name: string; row: number }>();
    for (const o of check.orders) for (const l of o.lines) {
      const n = need.get(l.productId) ?? { qty: 0, name: l.product, row: l.row };
      n.qty += l.qty; need.set(l.productId, n);
    }
    for (const [pid, n] of need) {
      const have = onHand.get(pid) ?? 0;
      if (n.qty > have + 1e-9) check.errors.push({ row: n.row, message: `${n.name}: the file sends ${n.qty.toLocaleString("en-US")} but the sending branch has ${have.toLocaleString("en-US")} in stock.` });
    }
    // Trucks used in the last 3 days (advice only).
    const recent = await Promise.all(check.orders.map((o) => checkRecentTruckUse({ vehicle: o.vehicle, trailer: o.trailer || null })));
    recent.forEach((r, i) => {
      if (r.ok && r.matches.length) {
        const m = r.matches[0];
        check.warnings.push({ row: check.orders[i].rows[0], message: `Truck ${check.orders[i].vehicle} was used ${m.date} on ${m.transferNumber ?? "a transfer"}${m.tripNo ? ` trip ${m.tripNo}` : ""} (${m.reasons.join(", ")}). Check it is not entered twice.` });
      }
    });
    check.errors.sort((a, b) => a.row - b.row);
    return { ok: true, check, totals: { orders: check.orders.length, quantity: check.orders.reduce((a, o) => a + o.lines.reduce((b, l) => b + l.qty, 0), 0) } };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Could not read the file." }; }
}

export type CreateResult = { ok: boolean; error?: string; created: { vehicle: string; toBranch: string; id: string }[]; failed: { vehicle: string; toBranch: string; error: string }[] };

/**
 * Create one transfer order per truck from a checked file. Each truck has its
 * own retry key, so pressing again after a failure never creates a truck twice.
 */
export async function createImportedOrders(sourceBranchId: string, orders: ImportOrder[], requestId: string): Promise<CreateResult> {
  const out: CreateResult = { ok: true, created: [], failed: [] };
  try {
    const user = await assertActiveUser();
    assertPermission(user, "inventory.transfer_create");
    if (!requestId || requestId.length < 16) return { ...out, ok: false, error: "Missing request id; reload the page." };
    if (!Array.isArray(orders) || orders.length === 0) return { ...out, ok: false, error: "Nothing to create." };
    if (orders.length > 300) return { ...out, ok: false, error: "Create at most 300 trucks at a time." };
    const ctx = await getActiveContext();
    const licence = canUseLicenceNumber(user);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Dar_es_Salaam" }).format(new Date());
    for (const [i, o] of orders.entries()) {
      const res = await createTransferWithTrip({
        sourceBranchId, destinationBranchId: o.toBranchId, transferDate: today, expectedArrivalAt: null, reference: "", notes: "",
        requestId: `${requestId}:truck:${i}:${o.vehicle}`, dispatch: false,
        lines: o.lines.map((l) => ({ product_id: l.productId, qty: Number(l.qty) })),
        transport: {
          driverName: o.driverName, driverPhone: o.driverPhone, driverLicence: licence ? o.driverLicence : undefined,
          vehicleRegistration: o.vehicle, trailerRegistration: o.trailer, transporterName: o.transporter, transporterContact: o.transporterContact,
        },
        charges: [],
      });
      if (res.ok && res.id) out.created.push({ vehicle: o.vehicle, toBranch: o.toBranch, id: res.id });
      else out.failed.push({ vehicle: o.vehicle, toBranch: o.toBranch, error: res.error ?? "Failed." });
    }
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: sourceBranchId, action: "transfer.bulk_import", resourceType: "stock_transfer",
      newValues: { created: out.created.length, failed: out.failed.length } });
    revalidatePath("/inventory/transfers");
    out.ok = out.failed.length === 0;
    return out;
  } catch (e) { return { ...out, ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}
