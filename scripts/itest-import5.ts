/**
 * Import upgrade - Stage 5 (bulk-to-bag rebagging).
 * One transaction, ROLLED BACK. PGlite test database only (npm run test:db).
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-import5 runs only against the PGlite test database (npm run test:db).");
  process.exit(1);
}

let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { console.error(`  FAIL ${name} ${detail}`); process.exitCode = 1; }
}
async function one<T = string>(db: Client, sql: string, p: unknown[] = []): Promise<T> {
  const { rows } = await db.query(sql, p);
  return (rows[0] ? Object.values(rows[0])[0] : null) as T;
}
async function failMsg(db: Client, sql: string, p: unknown[] = []): Promise<string | null> {
  await db.query("savepoint sp");
  try { await db.query(sql, p); await db.query("release savepoint sp"); return null; }
  catch (e) { await db.query("rollback to savepoint sp"); return (e as Error).message; }
}
const fails = async (db: Client, sql: string, p: unknown[] = [], expect?: string) => {
  const m = await failMsg(db, sql, p);
  return m !== null && (!expect || m.toLowerCase().includes(expect.toLowerCase()));
};
let k = 0;
const key = () => `stage5-key-${++k}-${Math.random().toString(36).slice(2)}`;
const n = (x: unknown) => Number(x);

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    const Y = new Date().getFullYear();
    const d = (md: string) => `${Y}-${md}`;
    const co = await one(db, "select id from companies where code='ELEMENTS'");
    const owner = await one(db, "select id from user_profiles where is_primary_owner");
    const hq = await one(db, "select id from branches where company_id=$1 and code='HQ'", [co]);
    const mwz = await one(db, "insert into branches(company_id, code, name) values ($1,'MWZ5','Mwanza') returning id", [co]);
    const kg = await one(db, "select id from units where company_id=$1 and code='KG'", [co]);
    const bag = await one(db, "select id from units where company_id=$1 and code='BAG'", [co]);
    await db.query("update feature_flags set is_enabled=true where company_id=$1 and flag_key in ('imports','rebagging')", [co]);

    const bulkP = (sku: string, tol = 0) => one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role, rebag_loss_tolerance_pct) values ($1,$2,$2,$3,'bulk',$4) returning id", [co, sku, kg, tol]);
    const packP = (sku: string, kgs: number, bulk: string) => one(db,
      "insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id) values ($1,$2,$2,$3,'packaged',$4,$5) returning id", [co, sku, bag, kgs, bulk]);
    const matP = (sku: string) => one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,$2,$2,$3,'packaging_material') returning id", [co, sku, bag]);
    const acc = (code: string) => one(db, "select id from chart_of_accounts where company_id=$1 and code=$2", [co, code]);
    const a1150 = await acc("1150"), a3200 = await acc("3200");
    // Opening stock with its journal (Dr 1150 / Cr 3200) so GL and subledger agree.
    const opening = async (prod: string, qty: number, value: number, br = hq) => {
      await db.query("select record_stock_movement_value($1,$2,$3,'opening','opening',gen_random_uuid(),'OPEN',$4,$5,$6)", [co, br, prod, qty, value, owner]);
      await db.query("select create_journal($1,$2,$3,'opening',gen_random_uuid(),'OPEN','opening',$4,$5::jsonb)", [co, br, d("01-01"), owner,
        JSON.stringify([{ account_id: a1150, debit: value, credit: 0 }, { account_id: a3200, debit: 0, credit: value }])]);
    };
    const gl = async (code: string) => n(await one(db, `select coalesce(sum(l.debit-l.credit),0) from journal_lines l join journal_entries j on j.id=l.journal_id
       where j.company_id=$1 and l.account_id=(select id from chart_of_accounts where company_id=$1 and code=$2)`, [co, code]));
    const jl = async (st: string, sid: string) => (await db.query<{ code: string; d: string; c: string }>(
      `select c.code, sum(l.debit)::text d, sum(l.credit)::text c from journal_entries j join journal_lines l on l.journal_id=j.id
       join chart_of_accounts c on c.id=l.account_id where j.source_type=$1 and j.source_id=$2 group by c.code order by c.code`, [st, sid]))
      .rows.map((r) => `${r.code}:${n(r.d)}/${n(r.c)}`).join(" ");
    const stock = async (prod: string, br = hq) => (await db.query<{ q: string; v: string; a: string }>(
      "select quantity::text q, stock_value::text v, avg_unit_cost::text a from stock_balances where product_id=$1 and branch_id=$2", [prod, br])).rows[0]
      ?? { q: "0", v: "0", a: "0" };
    const order = (bulk: string, br = hq, date = d("02-01")) =>
      one(db, "insert into rebag_orders(company_id, branch_id, bulk_product_id, order_date, operator_name, location) values ($1,$2,$3,$4,'Op','Bay 1') returning id", [co, br, bulk, date]);
    const bulkIn = (o: string, prod: string, qty: number, lot: string | null = null) =>
      db.query("insert into rebag_inputs(company_id, order_id, input_kind, product_id, quantity, lot_id) values ($1,$2,'bulk',$3,$4,$5)", [co, o, prod, qty, lot]);
    const out = (o: string, prod: string, bags: number, kgPer: number, no: number) =>
      one(db, "insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg, line_no) values ($1,$2,$3,$4,$5,$6) returning id", [co, o, prod, bags, bags * kgPer, no]);
    const pack = (o: string, prod: string, qty: number, target: string | null, perBag: number | null = 1, damaged = 0) =>
      one(db, "insert into rebag_inputs(company_id, order_id, input_kind, product_id, quantity, target_output_id, qty_per_bag, damaged_qty) values ($1,$2,'packaging',$3,$4,$5,$6,$7) returning id",
        [co, o, prod, qty, target, perBag, damaged]);
    const labour = (o: string, amount: number, basis: string | null = null) => one(db,
      "insert into cost_sources(company_id, owner_type, rebag_order_id, cost_category_id, estimated_amount, description, allocation_basis) values ($1,'rebag_order',$2,(select id from cost_categories where company_id=$1 and code='REBAG_LAB'),$3,'Filling crew',$4) returning id",
      [co, o, amount, basis]);
    const complete = (o: string, user = owner, kk = key()) => db.query("select complete_rebag_order($1,$2,$3)", [o, user, kk]);
    const status = (o: string) => one(db, "select document_status from rebag_orders where id=$1", [o]);
    const count = async (sql: string, p: unknown[]) => Number(await one(db, sql, p));

    // ------------------------------------------------------------ ACCEPTANCE A: mixed sizes, no loss
    const urea = await bulkP("UREA5");
    const u50 = await packP("UREA5-50", 50, urea), u25 = await packP("UREA5-25", 25, urea), u5 = await packP("UREA5-5", 5, urea);
    await opening(urea, 100000, 90000000);
    const oA = await order(urea);
    await bulkIn(oA, urea, 100000);
    await out(oA, u50, 1000, 50, 1); await out(oA, u25, 1600, 25, 2); await out(oA, u5, 2000, 5, 3);
    check("the flag gates rebagging", await (async () => {
      await db.query("update feature_flags set is_enabled=false where company_id=$1 and flag_key='rebagging'", [co]);
      const r = await fails(db, "select complete_rebag_order($1,$2,$3)", [oA, owner, key()], "not enabled");
      await db.query("update feature_flags set is_enabled=true where company_id=$1 and flag_key='rebagging'", [co]);
      return r;
    })());
    const kA = key();
    await complete(oA, owner, kA);
    const sA = [await stock(u50), await stock(u25), await stock(u5)];
    check("ACCEPTANCE A: 1,000 x 50 kg + 1,600 x 25 kg + 2,000 x 5 kg as three SKUs (not 4,600 bags of one size)",
      n(sA[0].q) === 1000 && n(sA[1].q) === 1600 && n(sA[2].q) === 2000, JSON.stringify(sA));
    check("ACCEPTANCE A: 100,000 kg and 4,600 bags out; bulk fully consumed",
      n(await one(db, "select sum(net_kg) from rebag_outputs where order_id=$1", [oA])) === 100000
      && n(await one(db, "select sum(bags) from rebag_outputs where order_id=$1", [oA])) === 4600 && n((await stock(urea)).q) === 0);
    check("ACCEPTANCE A: 900/kg carried to every size (45,000 / 22,500 / 4,500 per bag; 90M total)",
      n(sA[0].a) === 45000 && n(sA[1].a) === 22500 && n(sA[2].a) === 4500 && n(sA[0].v) + n(sA[1].v) + n(sA[2].v) === 90000000 && n((await stock(urea)).v) === 0);
    check("completion journal moves value within 1150 only", (await jl("rebag_order", oA)) === "1150:90000000/90000000", await jl("rebag_order", oA));
    await complete(oA, owner, kA);
    check("completion retry (same key) posts nothing more",
      await count("select count(*) from stock_movements where source_id=$1", [oA]) === 4
      && await count("select count(*) from journal_entries where source_id=$1", [oA]) === 1);
    check("a second completion (new key) is rejected", await fails(db, "select complete_rebag_order($1,$2,$3)", [oA, owner, key()], "already completed"));
    check("lines of a completed order are frozen", await fails(db, "update rebag_outputs set bags=999, net_kg=49950 where order_id=$1 and line_no=1", [oA], "cannot change"));

    // ------------------------------------------------------------ ACCEPTANCE B: packaging and labour per bag
    const npk = await bulkP("NPK5");
    const n50 = await packP("NPK5-50", 50, npk);
    const eb50 = await matP("EMPTY-BAG-50");
    await opening(npk, 50000, 45000000);
    await opening(eb50, 1000, 1000000);
    const oB = await order(npk);
    await bulkIn(oB, npk, 50000);
    const oB50 = await out(oB, n50, 1000, 50, 1);
    await pack(oB, eb50, 1000, oB50);
    const labB = await labour(oB, 500000);
    await complete(oB);
    check("ACCEPTANCE B: 900/kg bulk + 1,000 bag + 500 labour = TZS 46,500 per 50 kg bag",
      n((await stock(n50)).a) === 46500 && n((await stock(n50)).v) === 46500000, JSON.stringify(await stock(n50)));
    check("ACCEPTANCE B journal: Dr 1150 46.5M; Cr 1150 45M bulk + 1M bags; Cr 2140 0.5M labour accrued",
      (await jl("rebag_order", oB)) === "1150:46500000/46000000 2140:0/500000", await jl("rebag_order", oB));
    check("labour charge is accrued explicitly at completion; packaging stock consumed",
      (await one(db, "select status || '/' || accrued_amount from cost_sources where id=$1", [labB])) === "accrued/500000.00" && n((await stock(eb50)).q) === 0);
    const lab = await one(db, "select id from cost_categories where company_id=$1 and code='REBAG_LAB'", [co]);
    const crew = await one(db, "insert into suppliers(company_id, code, name) values ($1,'CREW5','Crew') returning id", [co]);
    const ci = async (lines: [string | null, number][], no: string) => {
      const id = await one(db, "insert into cost_invoices(company_id, branch_id, supplier_id, document_date, supplier_invoice_number) values ($1,$2,$3,$4,$5) returning id", [co, hq, crew, d("02-10"), no]);
      for (const [src, amt] of lines) await db.query("insert into cost_invoice_lines(company_id, cost_invoice_id, cost_category_id, cost_source_id, net_amount) values ($1,$2,$3,$4,$5)", [co, id, lab, src, amt]);
      return id;
    };
    const ciB = await ci([[labB, 520000]], "CREW-1");
    await db.query("select post_cost_invoice($1,$2,$3)", [ciB, owner, key()]);
    check("contractor invoice 520k replaces the 500k accrual; only +20k reaches the bags (46,520)",
      (await jl("cost_invoice", ciB)) === "1150:20000/0 2110:0/520000 2140:500000/0" && n((await stock(n50)).a) === 46520, await jl("cost_invoice", ciB));
    check("the same contractor charge cannot be invoiced twice", await (async () => {
      const x = await ci([[labB, 1]], "CREW-2");
      return fails(db, "select post_cost_invoice($1,$2,$3)", [x, owner, key()], "already has its actual");
    })());
    check("rebagging labour cannot be posted without its order charge (no duplicate expense)", await (async () => {
      const x = await ci([[null, 1]], "CREW-3");
      return fails(db, "select post_cost_invoice($1,$2,$3)", [x, owner, key()], "must be linked");
    })());
    check("order costing finalised once every charge has its invoice", (await one(db, "select cost_status from rebag_orders where id=$1", [oB])) === "finalized");

    // ------------------------------------------------------------ issue step, remaining bulk, losses, packaging reconciliation, shortages
    const can = await bulkP("CAN5", 0.2);
    const c50 = await packP("CAN5-50", 50, can), c25 = await packP("CAN5-25", 25, can), c5 = await packP("CAN5-5", 5, can);
    const ebc50 = await matP("EB-C50"), ebc25 = await matP("EB-C25"), thread = await matP("THREAD");
    await opening(can, 20000, 20000000);
    await opening(ebc50, 200, 160000); await opening(ebc25, 100, 50000); await opening(thread, 1000, 20000);
    const oC = await order(can);
    await bulkIn(oC, can, 10000);
    const kI = key();
    await db.query("select issue_rebag_order($1,$2,$3)", [oC, owner, kI]);
    check("issue takes 10,000 kg out of bulk at weighted average and holds 10M on the order (work in progress)",
      (await status(oC)) === "issued" && n((await stock(can)).q) === 10000 && n(await one(db, "select issued_value from rebag_orders where id=$1", [oC])) === 10000000
      && (await jl("rebag_order", oC)) === "");
    await db.query("select issue_rebag_order($1,$2,$3)", [oC, owner, kI]);
    check("issue retry posts once; a second issue is rejected",
      await count("select count(*) from stock_movements where source_id=$1 and movement_type='rebag_issue'", [oC]) === 1
      && await fails(db, "select issue_rebag_order($1,$2,$3)", [oC, owner, key()], "only a draft"));
    check("the bulk issue is fixed once issued", await fails(db, "update rebag_inputs set quantity=9000 where order_id=$1 and input_kind='bulk'", [oC], "fixed once issued"));
    const oC50 = await out(oC, c50, 100, 50, 1); await out(oC, c25, 150, 25, 2); await out(oC, c5, 200, 5, 3);
    await pack(oC, ebc50, 103, oC50, 1, 3);
    const p25 = await pack(oC, ebc25, 150, await one(db, "select id from rebag_outputs where order_id=$1 and line_no=2", [oC]), 1, 0);
    await pack(oC, thread, 450, null, null);
    await db.query("update rebag_orders set returned_kg=200, normal_loss_kg=50, abnormal_loss_kg=0 where id=$1", [oC]);
    check("kg must balance (issued = packed + returned + loss)", await (async () => {
      await db.query("update rebag_orders set returned_kg=150 where id=$1", [oC]);
      const r = await fails(db, "select complete_rebag_order($1,$2,$3)", [oC, owner, key()], "does not balance");
      await db.query("update rebag_orders set returned_kg=200 where id=$1", [oC]);
      return r;
    })());
    check("loss above the 0.2% tolerance is not all treated as normal (20 kg allowed, 30 kg must be abnormal)",
      await fails(db, "select complete_rebag_order($1,$2,$3)", [oC, owner, key()], "record 30.0000 kg as abnormal"));
    await db.query("update rebag_orders set normal_loss_kg=20, abnormal_loss_kg=30 where id=$1", [oC]);
    const keeper = await one(db, "insert into auth.users(email) values ('k5@test.local') returning id");
    await db.query(`insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active)
                    values ($1,'k5@test.local','K',(select id from roles where code='STOREKEEPER'),$2,true)`, [keeper, co]);
    await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [keeper, co]);
    await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [keeper, hq]);
    check("abnormal loss needs an approver (storekeeper refused)", await fails(db, "select complete_rebag_order($1,$2,$3)", [oC, keeper, key()], "rebagging.approve"));
    check("packaging must reconcile: 102 used - 3 damaged <> 100 good bags", await (async () => {
      await db.query("update rebag_inputs set quantity=102 where order_id=$1 and product_id=$2", [oC, ebc50]);
      const r = await fails(db, "select complete_rebag_order($1,$2,$3)", [oC, owner, key()], "does not reconcile");
      await db.query("update rebag_inputs set quantity=103 where order_id=$1 and product_id=$2", [oC, ebc50]);
      return r;
    })());
    await db.query("update rebag_inputs set quantity=150 where id=$1", [p25]);
    check("packaging stock shortage (150 x 25 kg bags needed, 100 on hand) rejects the whole completion",
      await fails(db, "select complete_rebag_order($1,$2,$3)", [oC, owner, key()], "insufficient stock of eb-c25")
      && (await status(oC)) === "issued" && n((await stock(can)).q) === 10000 && n((await stock(c50)).q) === 0);
    await opening(ebc25, 50, 25000);
    await complete(oC);
    const vC = await db.query<{ line_no: number; bulk_value: string; packaging_value: string; value_tzs: string }>(
      "select line_no, bulk_value, packaging_value, value_tzs from rebag_outputs where order_id=$1 order by line_no", [oC]);
    check("completion from issued does not issue again", await count("select count(*) from stock_movements where source_id=$1 and movement_type='rebag_issue'", [oC]) === 1);
    check("200 kg unused bulk back at issue cost: bulk 10,200 kg / 10.2M",
      n((await stock(can)).q) === 10200 && n((await stock(can)).v) === 10200000);
    check("abnormal loss 30 kg expensed (Dr 6300 30k); normal 20 kg absorbed: outputs carry 9.77M bulk",
      (await jl("rebag_order", oC)).includes("6300:30000/0") && vC.rows.reduce((a, r) => a + n(r.bulk_value), 0) === 9770000, await jl("rebag_order", oC));
    check("packaging direct to its size: 50 kg 82,400 (103 bags incl. 3 damaged at 800) + thread 2,000; 25 kg 75,000 + thread 3,000; 5 kg thread 4,000 (by bags)",
      n(vC.rows[0].packaging_value) === 82400 + 2000 && n(vC.rows[1].packaging_value) === 75000 + 3000 && n(vC.rows[2].packaging_value) === 4000,
      JSON.stringify(vC.rows));
    check("different packaging cost per kg by size (not one rate for all sizes)",
      n(vC.rows[0].packaging_value) / 5000 !== n(vC.rows[2].packaging_value) / 1000);
    check("output value = bulk + packaging exactly (no residual)",
      vC.rows.reduce((a, r) => a + n(r.value_tzs), 0) === 9770000 + 82400 + 75000 + 9000
      && n(await one(db, "select output_value from rebag_orders where id=$1", [oC])) === 9936400);

    // ------------------------------------------------------------ shipment lots, several runs, late cost through conversion
    const dap = await bulkP("DAP5");
    const d50 = await packP("DAP5-50", 50, dap);
    const yara = await one(db, "insert into suppliers(company_id, code, name) values ($1,'YARA5','Yara') returning id", [co]);
    const sh = await one(db, `insert into import_shipments(company_id, branch_id, supplier_id, incoterm, goods_includes_freight, goods_includes_insurance,
                 currency_code, named_place, ownership_event) values ($1,$2,$3,'CIF',true,true,'TZS','Dar es Salaam','bill_of_lading') returning id`, [co, hq, yara]);
    const sl = await one(db, "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg, fc_amount, line_no) values ($1,$2,$3,10000,10000,9000000,1) returning id", [co, sh, dap]);
    const clr = await one(db, "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id, estimated_amount) values ($1,'import_shipment',$2,(select id from cost_categories where company_id=$1 and code='CLEARING'),1000000) returning id", [co, sh]);
    await db.query("select set_import_shipment_status($1,'dispatched',$2,$3)", [sh, d("02-01"), owner]);
    await db.query("select recognise_import_ownership($1,$2,null,$3,$4)", [sh, d("02-02"), owner, key()]);
    const rc = await one(db, "insert into import_receipts(company_id, shipment_id, branch_id, receipt_date) values ($1,$2,$3,$4) returning id", [co, sh, hq, d("02-03")]);
    await db.query("insert into import_receipt_lines(company_id, receipt_id, shipment_line_id, quantity_received, net_kg_received, is_final, line_no) values ($1,$2,$3,10000,10000,true,1)", [co, rc, sl]);
    await db.query("select post_import_receipt($1,$2,$3)", [rc, owner, key()]);
    const lot = await one(db, "select lot_id from import_receipt_lines where receipt_id=$1", [rc]);
    const run1 = await order(dap); await bulkIn(run1, dap, 5000, lot); await out(run1, d50, 100, 50, 1); await complete(run1);
    const run2 = await order(dap); await bulkIn(run2, dap, 3000, lot); await out(run2, d50, 60, 50, 1); await complete(run2);
    check("several production runs against one shipment, linked from the batch",
      await count("select count(*) from rebag_orders where import_shipment_id=$1 and document_status='completed'", [sh]) === 2);
    check("batch balance follows the runs (10,000 - 5,000 - 3,000 = 2,000 kg)",
      n(await one(db, "select quantity from stock_lot_balances where lot_id=$1 and branch_id=$2", [lot, hq])) === 2000);
    check("output lots trace back to the shipment batch",
      await count(`select count(*) from stock_lot_flows f join rebag_outputs o on o.lot_id=f.to_lot_id where f.from_lot_id=$1 and f.flow_type='rebag_produce'`, [lot]) === 2);
    await opening(dap, 1000, 900000); // untracked stock: enough kg in total, but not in the batch
    check("issuing more than the batch holds is rejected", await (async () => {
      const x = await order(dap); await bulkIn(x, dap, 2500, lot); await out(x, d50, 50, 50, 1);
      return fails(db, "select complete_rebag_order($1,$2,$3)", [x, owner, key()], "has only");
    })());
    const ciL = await one(db, "insert into cost_invoices(company_id, branch_id, supplier_id, document_date, supplier_invoice_number) values ($1,$2,$3,$4,'CLR-5') returning id", [co, hq, yara, d("02-20")]);
    await db.query("insert into cost_invoice_lines(company_id, cost_invoice_id, cost_category_id, cost_source_id, net_amount) values ($1,$2,(select id from cost_categories where company_id=$1 and code='CLEARING'),$3,1000000)", [co, ciL, clr]);
    await db.query("select post_cost_invoice($1,$2,$3)", [ciL, owner, key()]);
    check("late clearing cost 1M follows the goods through conversion: 0.2M bulk held, 0.8M into 160 bags (5,000/bag)",
      n((await stock(dap)).v) === 1800000 + 900000 + 200000 && n((await stock(d50)).v) === 160 * 45000 + 800000
      && n(await one(db, "select sum(cost_delta_tzs) from rebag_outputs o join rebag_orders r on r.id=o.order_id where r.import_shipment_id=$1", [sh])) === 800000,
      `${(await stock(dap)).v} ${(await stock(d50)).v} ${await jl("cost_invoice", ciL)}`);

    // ------------------------------------------------------------ cancellation, protected void
    const oD = await order(urea); await bulkIn(oD, urea, 10);
    await db.query("select cancel_rebag_order($1,$2,'not needed',$3)", [oD, owner, key()]);
    check("a draft cancels without postings", (await status(oD)) === "cancelled" && await count("select count(*) from stock_movements where source_id=$1", [oD]) === 0);
    const oE = await order(can); await bulkIn(oE, can, 1000);
    await db.query("select issue_rebag_order($1,$2,$3)", [oE, owner, key()]);
    await db.query("select cancel_rebag_order($1,$2,'machine down',$3)", [oE, owner, key()]);
    check("an issued order cancels by returning the bulk at its issue value",
      (await status(oE)) === "cancelled" && n((await stock(can)).q) === 10200 && n((await stock(can)).v) === 10200000);
    check("a completed order cannot be cancelled", await fails(db, "select cancel_rebag_order($1,$2,'x',$3)", [oA, owner, key()], "voided"));

    const oF = await order(can); await bulkIn(oF, can, 500); await out(oF, c50, 10, 50, 1);
    await complete(oF);
    const saleId = await one(db, "select gen_random_uuid()");
    await db.query("select record_stock_movement($1,$2,$3,'sale','sale',$4,'INV-9',0,3,0,$5)", [co, hq, c50, saleId, owner]);
    check("void is refused while bags from the order are sold (dependent document listed)",
      await fails(db, "select void_rebag_order($1,$2,'wrong size',$3)", [oF, owner, key()], "INV-9"));
    await db.query("select record_stock_movement($1,$2,$3,'sale_void','sale_void',$4,'INV-9',3,0,(select unit_cost from stock_movements where source_id=$4),$5)", [co, hq, c50, saleId, owner]);
    check("storekeeper cannot void a rebag order", await fails(db, "select void_rebag_order($1,$2,'x',$3)", [oF, keeper, key()], "rebagging.void"));
    const c50Before = await stock(c50);
    await db.query("select void_rebag_order($1,$2,'wrong size',$3)", [oF, owner, key()]);
    check("after the sale is reversed the void restores bulk and removes the bags at their value",
      (await status(oF)) === "voided" && n((await stock(can)).q) === 10200 && n((await stock(can)).v) === 10200000
      && n((await stock(c50)).q) === n(c50Before.q) - 10, JSON.stringify(await stock(can)));
    check("void journal mirrors the completion", (await jl("rebag_void", oF)) === "1150:500000/500000");

    // ------------------------------------------------------------ authorisation and API
    const cashier = await one(db, "insert into auth.users(email) values ('c5@test.local') returning id");
    await db.query(`insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active)
                    values ($1,'c5@test.local','C',(select id from roles where code='CASHIER'),$2,true)`, [cashier, co]);
    await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [cashier, co]);
    await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [cashier, hq]);
    const oG = await order(can); await bulkIn(oG, can, 50); await out(oG, c50, 1, 50, 1);
    check("a user without rebagging.post cannot complete", await fails(db, "select complete_rebag_order($1,$2,$3)", [oG, cashier, key()], "rebagging.post"));
    const oH = await order(can, mwz);
    check("a storekeeper of another branch cannot issue", await fails(db, "select issue_rebag_order($1,$2,$3)", [oH, keeper, key()]));
    check("storekeeper (rebagging.post) completes a loss-free order", (await failMsg(db, "select complete_rebag_order($1,$2,$3)", [oG, keeper, key()])) === null);
    check("app users cannot call rebagging functions",
      (await one<boolean>(db, "select has_function_privilege('authenticated','public.complete_rebag_order(uuid,uuid,text)','execute')")) === false
      && (await one<boolean>(db, "select has_function_privilege('authenticated','public.void_rebag_order(uuid,uuid,text,text)','execute')")) === false);
    check("status cannot be changed directly", await fails(db, "update rebag_orders set document_status='completed' where id=$1", [oH], "only through"));

    // ------------------------------------------------------------ reconciliation
    check("every journal balances", await count(`select count(*) from (select j.id from journal_entries j join journal_lines l on l.journal_id=j.id
      where j.company_id=$1 group by j.id having sum(l.debit) <> sum(l.credit)) x`, [co]) === 0);
    const sub = n(await one(db, "select coalesce(sum(stock_value),0) from stock_balances where company_id=$1", [co]));
    const wip = n(await one(db, "select coalesce(sum(issued_value),0) from rebag_orders where company_id=$1 and document_status='issued'", [co]));
    check("1150 GL = stock subledger + rebagging work in progress", (await gl("1150")) === sub + wip, `${await gl("1150")} vs ${sub}+${wip}`);
    check("2140 GL = charges accrued and not yet invoiced",
      (await gl("2140")) === -n(await one(db, "select coalesce(sum(accrued_amount),0) from cost_sources where company_id=$1 and status='accrued'", [co])));
    check("kg conserved on every completed order", await count(`select count(*) from rebag_orders r where company_id=$1 and document_status in ('completed','voided')
      and issued_kg <> returned_kg + normal_loss_kg + abnormal_loss_kg + (select sum(net_kg) from rebag_outputs where order_id=r.id)`, [co]) === 0);

    console.log(`\n${passed} rebagging Stage 5 checks passed. Rolling back.`);
  } catch (e) {
    console.error("\nRebagging Stage 5 test error:\n", e);
    process.exitCode = 1;
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main();
