/** Unit tests for bulk transfer orders from Excel / CSV. */
import ExcelJS from "exceljs";
import { buildOrders, parseCsv, matchBranch, matchProduct, parseQty, IMPORT_COLUMNS } from "../src/lib/transfers/bulk-import";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.error(`  FAIL ${name} ${detail}`); }
}

const branches = [
  { id: "hq", code: "HQ", name: "Head Office" },
  { id: "mlowo", code: "MLW", name: "Mlowo - Mbozi ( WIZA CMC LTD )" },
  { id: "mak", code: "MAK", name: "Makambako" },
];
const products = [
  { id: "p2", sku: "PRD-0002", name: "AMMONIUM SULPHATE 21%N – 24%S" },
  { id: "p3", sku: "PRD-0003", name: "UREA 46%" },
];
const H = [...IMPORT_COLUMNS] as string[];
const row = (n: number, v: Partial<Record<(typeof IMPORT_COLUMNS)[number], string>>) => ({ row: n, values: IMPORT_COLUMNS.map((c) => v[c] ?? "") });

// Matching
check("branch by exact name", matchBranch("Makambako", branches)?.id === "mak");
check("branch by name ignoring case and spacing", matchBranch("mlowo - mbozi (wiza cmc ltd)", branches)?.id === "mlowo");
check("branch by code", matchBranch("mak", branches)?.id === "mak");
check("unknown branch is not matched", matchBranch("Songea", branches) === null);
check("product by template text (SKU — name)", matchProduct("PRD-0002 — AMMONIUM SULPHATE 21%N – 24%S", products)?.id === "p2");
check("product by SKU", matchProduct("prd-0003", products)?.id === "p3");
check("product by name", matchProduct("Urea 46%", products)?.id === "p3");
check("quantities: 1,200 and 1 200 and 600", parseQty("1,200") === 1200 && parseQty("1 200") === 1200 && parseQty("600") === 600 && Number.isNaN(parseQty("six")));

// Grouping: one truck per order; continuation rows; normalisation
const ok = buildOrders([
  row(2, { "To branch": "Makambako", "Truck registration": "T 760 DWG", "Trailer registration": "t. 761 dwg", "Driver name": "Juma", "Driver phone": "712 345 678", Product: "PRD-0002 — AMMONIUM SULPHATE 21%N – 24%S", Quantity: "600" }),
  row(3, { Product: "PRD-0003", Quantity: "40" }),
  row(4, { "To branch": "Mlowo - Mbozi ( WIZA CMC LTD )", "Truck registration": "T123ABC", "Driver name": "Ali", Product: "PRD-0002", Quantity: "1,200" }),
  row(5, { "To branch": "Mlowo - Mbozi ( WIZA CMC LTD )", "Truck registration": "t-123-abc", Product: "PRD-0002", Quantity: "100" }),
  row(6, {}),
], H, branches, products, "hq");
check("no errors on a clean file", ok.errors.length === 0, JSON.stringify(ok.errors));
check("two trucks become two orders", ok.orders.length === 2);
const t1 = ok.orders[0], t2 = ok.orders[1];
check("registrations and phone are corrected (T760DWG, T761DWG, 0712345678)", t1.vehicle === "T760DWG" && t1.trailer === "T761DWG" && t1.driverPhone === "0712345678");
check("a row without branch and truck continues the truck above", t1.lines.length === 2 && t1.lines[1].qty === 40 && t1.rows.join() === "2,3");
check("the same truck on two rows (T 123 ABC written differently) is one order, same product added up", t2.lines.length === 1 && t2.lines[0].qty === 1300);

const bad = buildOrders([
  row(2, { "To branch": "Songea", "Truck registration": "T1", "Driver name": "x", Product: "PRD-0002", Quantity: "5" }),
  row(3, { "To branch": "Head Office", "Truck registration": "T2", "Driver name": "x", Product: "PRD-0002", Quantity: "5" }),
  row(4, { "To branch": "Makambako", "Truck registration": "T3", "Driver name": "x", Product: "Cement", Quantity: "5" }),
  row(5, { "To branch": "Makambako", "Truck registration": "T4", "Driver name": "x", Product: "PRD-0002", Quantity: "0" }),
  row(6, { "To branch": "Makambako", "Truck registration": "T5", Product: "PRD-0002", Quantity: "5" }),
  row(7, { "To branch": "Makambako", "Truck registration": "T6", "Driver name": "x", Product: "PRD-0002", Quantity: "5" }),
  row(8, { "To branch": "Mlowo - Mbozi ( WIZA CMC LTD )", "Truck registration": "T6", "Driver name": "x", Product: "PRD-0002", Quantity: "5" }),
], H, branches, products, "hq");
const msg = (r: number) => bad.errors.filter((e) => e.row === r).map((e) => e.message).join(" | ");
check("a branch not in the system is refused", /not a branch in the system/.test(msg(2)));
check("sending to the sending branch is refused", /is the sending branch/.test(msg(3)));
check("an unknown product is refused", /was not found/.test(msg(4)));
check("a zero quantity is refused", /above zero/.test(msg(5)));
check("a truck without a driver is refused", /driver's name/.test(msg(6)));
check("one truck for two branches is refused", /One truck goes to one branch/.test(msg(8)));
check("a file without the template columns is refused", /needs the columns/.test(buildOrders([], ["a", "b"], branches, products, "hq").errors[0]?.message ?? ""));

// CSV
const csv = parseCsv("﻿To branch,Truck registration,Driver name,Product,Quantity\r\nMakambako,\"T 760, DWG\",Juma,PRD-0002,\"1,200\"\r\n");
check("CSV with quotes, commas and a BOM", csv.length === 2 && csv[1][1] === "T 760, DWG" && csv[1][4] === "1,200");
const semi = parseCsv("To branch;Truck registration;Driver name;Product;Quantity\nMakambako;T1;Juma;PRD-0002;5\n");
check("CSV with semicolons (Excel in some regions)", semi[1][0] === "Makambako" && semi[1][4] === "5");
const csvOrders = buildOrders(csv.slice(1).map((values, i) => ({ row: i + 2, values })), csv[0], branches, products, "hq");
check("CSV with only the required columns works", csvOrders.errors.length === 0 && csvOrders.orders[0]?.lines[0]?.qty === 1200, JSON.stringify(csvOrders.errors));

// Excel round trip: write like the template, read like the import.
(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Transfer orders");
  ws.addRow(IMPORT_COLUMNS.map((c) => (["To branch", "Truck registration", "Driver name", "Product", "Quantity"].includes(c) ? `${c} *` : c)));
  ws.addRow(["Makambako", "T 760 DWG", "", "Juma", 712345678, "", "", "", "PRD-0002 — AMMONIUM SULPHATE 21%N – 24%S", 600]);
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf as ArrayBuffer);
  const s = back.getWorksheet("Transfer orders")!;
  const text = (r: ExcelJS.Row) => Array.from({ length: 10 }, (_, i) => { const v = r.getCell(i + 1).value; return typeof v === "number" ? String(v) : (r.getCell(i + 1).text ?? ""); });
  const res = buildOrders([{ row: 2, values: text(s.getRow(2)) }], text(s.getRow(1)), branches, products, "hq");
  check("an Excel file with * headers and numeric phone / quantity reads correctly", res.errors.length === 0 && res.orders[0]?.driverPhone === "0712345678" && res.orders[0]?.lines[0]?.qty === 600, JSON.stringify(res.errors));
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
