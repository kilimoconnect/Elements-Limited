import ExcelJS from "exceljs";
import { assertActiveUser } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveContext } from "@/lib/context";
import { IMPORT_COLUMNS } from "@/lib/transfers/bulk-import";

const ROWS = 500;
const BRAND = "FF1F6B3A";

/**
 * GET the Excel template for bulk transfer orders. "To branch" and "Product"
 * are drop-down lists of the branches and products defined in the system
 * (products: those the sending branch holds, when ?from= is given).
 */
export async function GET(req: Request) {
  let user;
  try { user = await assertActiveUser(); } catch { return new Response("Not signed in.", { status: 401 }); }
  if (!userHasPermission(user, "inventory.transfer_create")) return new Response("Not allowed.", { status: 403 });
  const ctx = await getActiveContext();
  const from = new URL(req.url).searchParams.get("from") ?? "";
  const admin = createAdminClient();
  const [{ data: branches }, { data: products }, { data: stock }] = await Promise.all([
    admin.from("branches").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("products").select("id, sku, name").eq("company_id", ctx.companyId).eq("is_active", true).order("sku"),
    /^[0-9a-f-]{36}$/i.test(from) ? admin.from("stock_balances").select("product_id, quantity").eq("branch_id", from).gt("quantity", 0) : Promise.resolve({ data: null }),
  ]);
  const held = stock ? new Set(stock.map((s) => s.product_id)) : null;
  const sourceName = (branches ?? []).find((b) => b.id === from)?.name;
  const toList = (branches ?? []).filter((b) => b.id !== from).map((b) => b.name);
  const productList = (products ?? []).filter((p) => !held || held.has(p.id)).map((p) => `${p.sku} — ${p.name}`);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Elements ERP";
  const ws = wb.addWorksheet("Transfer orders", { views: [{ state: "frozen", ySplit: 1 }] });
  const lists = wb.addWorksheet("Lists", { state: "hidden" });
  const help = wb.addWorksheet("How to fill");

  ws.columns = IMPORT_COLUMNS.map((h) => ({
    header: ["To branch", "Truck registration", "Driver name", "Product", "Quantity"].includes(h) ? `${h} *` : h,
    key: h, width: h === "Product" ? 46 : h === "To branch" ? 30 : 18,
  }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
  head.alignment = { vertical: "middle", wrapText: true };
  head.height = 30;

  lists.getColumn(1).values = ["Branches", ...toList];
  lists.getColumn(2).values = ["Products", ...productList];
  const col = (name: (typeof IMPORT_COLUMNS)[number]) => IMPORT_COLUMNS.indexOf(name) + 1;
  for (let r = 2; r <= ROWS + 1; r++) {
    const row = ws.getRow(r);
    row.getCell(col("To branch")).dataValidation = {
      type: "list", allowBlank: true, showErrorMessage: true, errorTitle: "Branch", error: "Choose a branch from the list.",
      formulae: [`Lists!$A$2:$A$${Math.max(toList.length + 1, 2)}`],
    };
    row.getCell(col("Product")).dataValidation = {
      type: "list", allowBlank: true, showErrorMessage: true, errorTitle: "Product", error: "Choose a product from the list.",
      formulae: [`Lists!$B$2:$B$${Math.max(productList.length + 1, 2)}`],
    };
    row.getCell(col("Quantity")).dataValidation = {
      type: "decimal", operator: "greaterThan", allowBlank: true, showErrorMessage: true, error: "Enter a quantity above zero.", formulae: [0],
    };
    // Phones keep their leading 0.
    row.getCell(col("Driver phone")).numFmt = "@";
    row.getCell(col("Transporter contact")).numFmt = "@";
  }

  help.getColumn(1).width = 110;
  [
    `Bulk transfer orders${sourceName ? ` from ${sourceName}` : ""}`,
    "",
    "1. Fill the 'Transfer orders' sheet: one row per product on a truck. Columns with * are required.",
    "2. To branch and Product: choose from the drop-down lists (the branches and products defined in the system).",
    "3. A truck carrying several products: repeat the truck on each row, or leave To branch and Truck registration empty on the next rows to continue the truck above.",
    "4. Each truck becomes one transfer order. Registrations and phone numbers are corrected automatically (T 760 DWG -> T760DWG).",
    "5. Upload the file on Transfer Orders > Import from Excel. You see every truck and any problem before anything is created.",
    "6. The store keeper then confirms loading of each truck, entering the expected arrival.",
  ].forEach((t, i) => { const c = help.getCell(`A${i + 1}`); c.value = t; if (i === 0) c.font = { bold: true, size: 14 }; });

  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="transfer-orders-template.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
