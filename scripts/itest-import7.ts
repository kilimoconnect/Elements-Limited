/**
 * Import upgrade - Stage 7 (late costs, corrections and accounting close).
 * One transaction, ROLLED BACK. PGlite test database only (npm run test:db).
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-import7 runs only against the PGlite test database (npm run test:db).");
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
const key = () => `stage7-key-${++k}-${Math.random().toString(36).slice(2)}`;
const n = (x: unknown) => Number(x);

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    const Y = new Date().getFullYear();
    const d = (md: string) => `${Y}-${md}`;
    const co = await one(db, "select id from companies where code='LETIQ'");
    const owner = await one(db, "select id from user_profiles where is_primary_owner");
    const hq = await one(db, "select id from branches where company_id=$1 and code='HQ'", [co]);
    const mwz = await one(db, "insert into branches(company_id, code, name) values ($1,'MWZ7','Mwanza') returning id", [co]);
    const kg = await one(db, "select id from units where company_id=$1 and code='KG'", [co]);
    const bag = await one(db, "select id from units where company_id=$1 and code='BAG'", [co]);
    const cash = await one(db, "select id from payment_accounts where company_id=$1 and code='CASH'", [co]);
    const walkin = await one(db, "select id from customers where company_id=$1 and code='WALK-IN'", [co]);
    await db.query("update feature_flags set is_enabled=true where company_id=$1 and flag_key in ('imports','rebagging','transfer_logistics')", [co]);
    const sup = await one(db, "insert into suppliers(company_id, code, name) values ($1,'AGRO7','Agro Supplies') returning id", [co]);
    const haul = await one(db, "insert into suppliers(company_id, code, name) values ($1,'HAUL7','Haulage Co') returning id", [co]);

    const bulkP = (sku: string) => one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,$2,$2,$3,'bulk') returning id", [co, sku, kg]);
    const bagP = (sku: string, bulk: string) => one(db,
      "insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id) values ($1,$2,$2,$3,'packaged',50,$4) returning id", [co, sku, bag, bulk]);
    const gl = async (code: string) => n(await one(db, `select coalesce(sum(l.debit-l.credit),0) from journal_lines l join journal_entries j on j.id=l.journal_id
       where j.company_id=$1 and l.account_id=(select id from chart_of_accounts where company_id=$1 and code=$2)`, [co, code]));
    const jl = async (st: string, sid: string) => (await db.query<{ code: string; d: string; c: string }>(
      `select c.code, sum(l.debit)::text d, sum(l.credit)::text c from journal_entries j join journal_lines l on l.journal_id=j.id
       join chart_of_accounts c on c.id=l.account_id where j.source_type=$1 and j.source_id=$2 group by c.code order by c.code`, [st, sid]))
      .rows.map((r) => `${r.code}:${n(r.d)}/${n(r.c)}`).join(" ");
    const stock = async (prod: string, br = hq) => (await db.query<{ q: string; v: string }>(
      "select quantity::text q, stock_value::text v from stock_balances where product_id=$1 and branch_id=$2", [prod, br])).rows[0] ?? { q: "0", v: "0" };
    const purchase = async (prod: string, qty: number, cost: number, date = d("03-01"), paid = false) => {
      const id = await one(db, "insert into purchases(company_id, branch_id, supplier_id, document_date, supplier_invoice_number) values ($1,$2,$3,$4,$5) returning id",
        [co, hq, sup, date, `INV-${k}-${Math.random().toString(36).slice(2, 7)}`]);
      await db.query("insert into purchase_lines(purchase_id, product_id, quantity, unit_cost, is_recoverable) values ($1,$2,$3,$4,true)", [id, prod, qty, cost]);
      if (paid) await db.query("insert into purchase_payments(purchase_id, payment_account_id, amount, payment_date) values ($1,$2,$3,$4)", [id, cash, qty * cost, date]);
      await db.query("select post_purchase($1,$2,$3)", [id, owner, key()]);
      return id;
    };
    const sale = async (prod: string, qty: number, br = hq, date = d("03-05")) => {
      const id = await one(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, grand_total) values ($1,$2,$3,$4,$5,$6) returning id",
        [co, br, date, walkin, owner, qty * 100]);
      await db.query(`insert into sale_lines(sale_id, product_id, quantity, unit_price, net_amount, tax_amount, line_total, track_inventory, line_no)
                      values ($1,$2,$3,100,$4,0,$4,true,1)`, [id, prod, qty, qty * 100]);
      await db.query("insert into sale_payments(sale_id, payment_account_id, amount) values ($1,$2,$3)", [id, cash, qty * 100]);
      await db.query("select post_sale($1,$2,null)", [id, owner]);
      return id;
    };
    const costSource = (pur: string, cat: string, est: number, basis = "quantity") => one(db,
      `insert into cost_sources(company_id, owner_type, purchase_id, cost_category_id, estimated_amount, description, allocation_basis)
       values ($1,'purchase',$2,(select id from cost_categories where company_id=$1 and code=$3),$4,$3,$5) returning id`, [co, pur, cat, est, basis]);
    const costInvoice = async (src: string | null, cat: string, amt: number, date = d("03-20"), kind = "invoice", credited: string | null = null, no = `CI-${k}-${Math.random().toString(36).slice(2, 7)}`) => {
      const id = await one(db, `insert into cost_invoices(company_id, branch_id, supplier_id, document_date, supplier_invoice_number, document_kind, credited_invoice_id)
                               values ($1,$2,$3,$4,$5,$6,$7) returning id`, [co, hq, haul, date, no, kind, credited]);
      await db.query("insert into cost_invoice_lines(company_id, cost_invoice_id, cost_category_id, cost_source_id, net_amount) values ($1,$2,(select id from cost_categories where company_id=$1 and code=$3),$4,$5)",
        [co, id, cat, src, amt]);
      return id;
    };
    const post = (ci: string) => db.query("select post_cost_invoice($1,$2,$3)", [ci, owner, key()]);
    const deltaSum = async (srcId: string) => n(await one(db, "select coalesce(sum(amount),0) from cost_delta_lines where src_id=$1", [srcId]));
    const target = async (srcId: string, t: string) => n(await one(db, "select coalesce(sum(amount),0) from cost_delta_lines where src_id=$1 and target=$2", [srcId, t]));

    // ------------------------------------------------------------ ACCEPTANCE: 1,000 bags, 600 on hand, 400 sold, +1,000,000
    const bulkA = await bulkP("BLK7A");
    const bagA = await bagP("BAG7A", bulkA);
    const purA = await purchase(bagA, 1000, 40000);
    const saleA = await sale(bagA, 400);
    const srcA = await costSource(purA, "TRANSPORT", 1000000);
    const kA = key();
    await db.query("select accrue_purchase_cost($1,1000000,$2,$3,$4)", [srcA, d("03-10"), owner, kA]);
    check("ACCEPTANCE: +1,000,000 on 1,000 equal bags (600 held, 400 sold) = 600,000 inventory + 400,000 cost of sales",
      (await jl("cost_accrual", srcA)) === "1150:600000/0 2140:0/1000000 5100:400000/0" && n((await stock(bagA)).v) === 24600000, await jl("cost_accrual", srcA));
    await db.query("select accrue_purchase_cost($1,1000000,$2,$3,$4)", [srcA, d("03-10"), owner, kA]);
    check("accrual retry posts nothing more", Number(await one(db, "select count(*) from journal_entries where source_id=$1", [srcA])) === 1);
    check("delta evidence: 600,000 to stock (600 units), 400,000 to cost of sales on the sale (400 units)",
      (await target(srcA, "stock")) === 600000 && (await target(srcA, "cogs")) === 400000
      && n(await one(db, "select units from cost_delta_lines where src_id=$1 and target='cogs' and ref_type='sale' and ref_id=$2", [srcA, saleA])) === 400);
    const ciA = await costInvoice(srcA, "TRANSPORT", 1000000);
    await post(ciA);
    check("ACCEPTANCE: invoice matching the accrual adds zero inventory cost (Dr 2140 / Cr 2110 only)",
      (await jl("cost_invoice", ciA)) === "2110:0/1000000 2140:1000000/0" && n((await stock(bagA)).v) === 24600000 && (await deltaSum(ciA)) === 0);
    check("cost history: estimated → accrued → invoiced kept",
      (await one(db, "select string_agg(coalesce(new_status,'?'), '>' order by changed_at) from cost_source_history where cost_source_id=$1", [srcA])) === "estimated>accrued>invoiced");
    check("allocation evidence equals the source amount",
      n(await one(db, "select sum(a.amount) from cost_allocations a join cost_allocation_runs r on r.id=a.run_id where r.cost_source_id=$1", [srcA])) === 1000000);

    // ------------------------------------------------------------ destination and in-transit shares
    const bulkB = await bulkP("BLK7B");
    const bagB = await bagP("BAG7B", bulkB);
    const purB = await purchase(bagB, 1000, 10000);
    await sale(bagB, 400);
    const trB = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id) values ($1,$2,$3) returning id", [co, hq, mwz]);
    const tlB = await one(db, "insert into stock_transfer_lines(transfer_id, product_id, qty_requested) values ($1,$2,300) returning id", [trB, bagB]);
    await db.query("select dispatch_stock_transfer($1,$2,$3)", [trB, owner, key()]);
    await db.query("select receive_stock_transfer($1,$2,$3::jsonb,$4)", [trB, owner, JSON.stringify([{ line_id: tlB, qty: 200 }]), key()]);
    const srcB = await costSource(purB, "TRANSPORT", 0);
    const ciB = await costInvoice(srcB, "TRANSPORT", 1000000);
    await post(ciB);
    check("late 1,000,000 reaches HQ held 300k, sold 400k, Mwanza held 200k and in-transit 100k",
      (await jl("cost_invoice", ciB)) === "1150:500000/0 1155:100000/0 2110:0/1000000 5100:400000/0"
      && n((await stock(bagB)).v) === 3300000 && n((await stock(bagB, mwz)).v) === 2200000
      && n(await one(db, "select transit_value from stock_transfer_dispatch_lines where transfer_line_id=$1", [tlB])) === 1100000, await jl("cost_invoice", ciB));
    check("every part of the delta is recorded and sums to the invoice", (await deltaSum(ciB)) === 1000000 && (await target(ciB, "transit")) === 100000);
    await db.query("select receive_stock_transfer($1,$2,$3::jsonb,$4)", [trB, owner, JSON.stringify([{ line_id: tlB, qty: 100 }]), key()]);
    check("in-transit share arrives with the goods: Mwanza 300 bags at 11,000 (3.3M)", n((await stock(bagB, mwz)).v) === 3300000);
    const cnB = await costInvoice(srcB, "TRANSPORT", 200000, d("03-22"), "credit_note", ciB);
    await post(cnB);
    check("negative correction (credit note 200k): HQ -60k, Mwanza -60k, cost of sales -80k",
      (await jl("cost_invoice", cnB)) === "1150:0/120000 2110:200000/0 5100:0/80000" && n((await stock(bagB)).v) === 3240000 && n((await stock(bagB, mwz)).v) === 3240000,
      await jl("cost_invoice", cnB));
    check("credits cannot exceed the credited invoice", await (async () => {
      const x = await costInvoice(srcB, "TRANSPORT", 900000, d("03-22"), "credit_note", ciB);
      return fails(db, "select post_cost_invoice($1,$2,$3)", [x, owner, key()], "exceed");
    })());
    await sale(bagB, 300, hq, d("03-25"));
    const adjB = await one(db, "insert into purchase_cost_adjustments(company_id, purchase_id, kind, document_date, reason, supplier_reference) values ($1,$2,'credit_note',$3,'price agreed lower','CN-77') returning id", [co, purB, d("03-26")]);
    await db.query("insert into purchase_cost_adjustment_lines(company_id, adjustment_id, purchase_line_id, amount) values ($1,$2,(select id from purchase_lines where purchase_id=$3),100000)", [co, adjB, purB]);
    const payBefore = n(await one(db, "select outstanding from supplier_payables where purchase_id=$1", [purB]));
    await db.query("select post_purchase_cost_adjustment($1,$2,$3)", [adjB, owner, key()]);
    check("supplier price credit 100k after HQ sold out: HQ part to cost of sales, Mwanza -30k, payable -100k",
      (await jl("purchase_cost_adjustment", adjB)) === "1150:0/30000 2110:100000/0 5100:0/70000" && n((await stock(bagB)).q) === 0 && n((await stock(bagB)).v) === 0
      && n(await one(db, "select outstanding from supplier_payables where purchase_id=$1", [purB])) === payBefore - 100000, await jl("purchase_cost_adjustment", adjB));

    // ------------------------------------------------------------ returns after adjustment
    const slA = await one(db, "select id from sale_lines where sale_id=$1", [saleA]);
    const ret = await one(db, "insert into sales_returns(company_id, branch_id, sale_id, customer_id, reason, created_by) values ($1,$2,$3,$4,'returned',$5) returning id", [co, hq, saleA, walkin, owner]);
    await db.query(`insert into sales_return_lines(return_id, sale_line_id, product_id, quantity, unit_price, net_amount, tax_amount, line_total, unit_cost, condition, track_inventory, line_no)
                    values ($1,$2,$3,100,100,10000,0,10000,(select unit_cost from sale_lines where id=$2),'saleable',true,1)`, [ret, slA, bagA]);
    await db.query("select post_sales_return($1,$2,null)", [ret, owner]);
    check("return of 100 bags after the late cost brings their 100,000 back to stock (28.7M for 700 bags)",
      (await jl("late_cost_return", ret)) === "1150:100000/0 5100:0/100000" && n((await stock(bagA)).q) === 700 && n((await stock(bagA)).v) === 28700000, await jl("late_cost_return", ret));
    const srcA2 = await costSource(purA, "LOADING", 0);
    const ciA2 = await costInvoice(srcA2, "LOADING", 700000);
    await post(ciA2);
    check("a further 700,000 after the return: returned units count as held (490k stock, 210k cost of sales)",
      (await jl("cost_invoice", ciA2)) === "1150:490000/0 2110:0/700000 5100:210000/0" && n((await stock(bagA)).v) === 29190000, await jl("cost_invoice", ciA2));
    await db.query("select void_sales_return($1,$2,'customer kept them')", [ret, owner]);
    const sA = await stock(bagA);
    check("voiding the return takes the units out at average (4.17M) and aligns the GL (170k to cost of sales)",
      n(sA.q) === 600 && n(sA.v) === 25020000 && (await jl("late_cost_return_void", ret)) === "1150:0/170000 5100:170000/0", `${JSON.stringify(sA)} ${await jl("late_cost_return_void", ret)}`);

    // ------------------------------------------------------------ rebagging, then a transfer, then sales
    const bulkR = await bulkP("BLK7R");
    const bagR = await bagP("BAG7R", bulkR);
    const purR = await purchase(bulkR, 10000, 900);
    const ro = await one(db, "insert into rebag_orders(company_id, branch_id, bulk_product_id, order_date) values ($1,$2,$3,$4) returning id", [co, hq, bulkR, d("03-06")]);
    await db.query("insert into rebag_inputs(company_id, order_id, input_kind, product_id, quantity) values ($1,$2,'bulk',$3,5000)", [co, ro, bulkR]);
    await db.query("insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg, line_no) values ($1,$2,$3,100,5000,1)", [co, ro, bagR]);
    await db.query("select complete_rebag_order($1,$2,$3)", [ro, owner, key()]);
    const trR = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id) values ($1,$2,$3) returning id", [co, hq, mwz]);
    const tlR = await one(db, "insert into stock_transfer_lines(transfer_id, product_id, qty_requested) values ($1,$2,40) returning id", [trR, bagR]);
    await db.query("select dispatch_stock_transfer($1,$2,$3)", [trR, owner, key()]);
    await db.query("select receive_stock_transfer($1,$2,$3::jsonb,$4)", [trR, owner, JSON.stringify([{ line_id: tlR, qty: 40 }]), key()]);
    await sale(bagR, 30, mwz);
    await sale(bagR, 20, hq);
    const srcR = await costSource(purR, "TRANSPORT", 0);
    const ciR = await costInvoice(srcR, "TRANSPORT", 1000000);
    await post(ciR);
    check("late cost on bulk follows rebagging → transfer → sales: bulk 500k, HQ bags 200k, Mwanza bags 50k, cost of sales 250k",
      (await jl("cost_invoice", ciR)) === "1150:750000/0 2110:0/1000000 5100:250000/0"
      && n((await stock(bulkR)).v) === 5000000 && n((await stock(bagR)).v) === 2000000 && n((await stock(bagR, mwz)).v) === 500000, await jl("cost_invoice", ciR));
    check("the bag outputs record the late cost they received", n(await one(db, "select cost_delta_tzs from rebag_outputs where order_id=$1", [ro])) === 500000);

    // ------------------------------------------------------------ reversal of a cost invoice, multiple deltas
    const bulkD = await bulkP("BLK7D");
    const bagD = await bagP("BAG7D", bulkD);
    const purD = await purchase(bagD, 100, 1000);
    const srcD = await costSource(purD, "LOADING", 10000);
    await db.query("select accrue_purchase_cost($1,10000,$2,$3,$4)", [srcD, d("03-10"), owner, key()]);
    const ciD = await costInvoice(srcD, "LOADING", 12000, d("03-20"), "invoice", null, "LOAD-1");
    await post(ciD);
    check("actual 12,000 vs accrual 10,000: only +2,000", (await jl("cost_invoice", ciD)) === "1150:2000/0 2110:0/12000 2140:10000/0" && n((await stock(bagD)).v) === 112000);
    check("storekeeper-level users cannot reverse cost invoices", await (async () => {
      const ku = await one(db, "insert into auth.users(email) values ('k7@test.local') returning id");
      await db.query(`insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active) values ($1,'k7@test.local','K',(select id from roles where code='STOREKEEPER'),$2,true)`, [ku, co]);
      await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [ku, co]);
      await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [ku, hq]);
      return fails(db, "select void_cost_invoice($1,$2,'x',$3)", [ciD, ku, key()], "cost_invoices.void");
    })());
    const kv = key();
    await db.query("select void_cost_invoice($1,$2,'wrong amount',$3)", [ciD, owner, kv]);
    await db.query("select void_cost_invoice($1,$2,'wrong amount',$3)", [ciD, owner, kv]);
    check("reversal: payable reversed, accrual re-instated, the 2,000 difference taken back; retry posts once",
      (await jl("cost_invoice_void", ciD)) === "1150:0/2000 2110:12000/0 2140:0/10000" && n((await stock(bagD)).v) === 110000
      && (await one(db, "select status || '/' || accrued_amount from cost_sources where id=$1", [srcD])) === "accrued/10000.00"
      && Number(await one(db, "select count(*) from journal_entries where source_type='cost_invoice_void' and source_id=$1", [ciD])) === 1, await jl("cost_invoice_void", ciD));
    const ciD2 = await costInvoice(srcD, "LOADING", 11000, d("03-21"), "invoice", null, "LOAD-1");
    await post(ciD2);
    check("the corrected invoice (same supplier number, freed by the reversal) posts +1,000", n((await stock(bagD)).v) === 111000);
    check("an invoice with credit notes cannot be reversed", await fails(db, "select void_cost_invoice($1,$2,'x',$3)", [ciB, owner, key()], "credit notes"));

    // ------------------------------------------------------------ vendor refund
    const bulkE = await bulkP("BLK7E");
    const bagE = await bagP("BAG7E", bulkE);
    const purE = await purchase(bagE, 10, 1000, d("03-02"), true);
    const adjE = await one(db, "insert into purchase_cost_adjustments(company_id, purchase_id, kind, document_date, reason) values ($1,$2,'credit_note',$3,'overcharge') returning id", [co, purE, d("03-26")]);
    await db.query("insert into purchase_cost_adjustment_lines(company_id, adjustment_id, purchase_line_id, amount) values ($1,$2,(select id from purchase_lines where purchase_id=$3),5000)", [co, adjE, purE]);
    await db.query("select post_purchase_cost_adjustment($1,$2,$3)", [adjE, owner, key()]);
    const credE = await one(db, "select id from supplier_credits where supplier_id=$1 and amount=5000 order by created_at desc limit 1", [sup]);
    check("credit note on a paid purchase becomes a supplier credit (Dr 1170) and lowers the stock (-5,000)",
      (await jl("purchase_cost_adjustment", adjE)) === "1150:0/5000 1170:5000/0" && n((await stock(bagE)).v) === 5000 && credE !== null, await jl("purchase_cost_adjustment", adjE));
    check("a purchase with posted price adjustments cannot be voided", await fails(db, "select void_purchase($1,$2,'x')", [purE, owner], "adjustments"));
    const kr = key();
    const refund = await one(db, "select refund_supplier_credit($1,$2,3000,$3,'RF-1',$4,$5)", [credE, cash, d("03-27"), owner, kr]);
    await db.query("select refund_supplier_credit($1,$2,3000,$3,'RF-1',$4,$5)", [credE, cash, d("03-27"), owner, kr]);
    check("vendor refund 3,000 in cash: Cr 1170, credit 2,000 left; retry once",
      (await one(db, "select remaining from supplier_credits where id=$1", [credE])) === "2000.00"
      && Number(await one(db, "select count(*) from supplier_credit_refunds where credit_id=$1", [credE])) === 1 && refund !== null);
    check("refund cannot exceed the open credit", await fails(db, "select refund_supplier_credit($1,$2,2500,$3,null,$4,$5)", [credE, cash, d("03-27"), owner, key()], "at most"));

    // ------------------------------------------------------------ blended receipts (weighted average, not batch costing)
    const bulkF = await bulkP("BLK7F");
    const bagF = await bagP("BAG7F", bulkF);
    const purF1 = await purchase(bagF, 100, 1000, d("03-03"));
    await purchase(bagF, 100, 2000, d("03-04"));
    await sale(bagF, 100, hq, d("03-05"));
    const srcF = await costSource(purF1, "TRANSPORT", 0);
    const ciF = await costInvoice(srcF, "TRANSPORT", 10000);
    await post(ciF);
    check("blended pool: the sale took half of each receipt, so the first receipt's 10,000 splits 5,000 sold / 5,000 held",
      (await jl("cost_invoice", ciF)) === "1150:5000/0 2110:0/10000 5100:5000/0" && n((await stock(bagF)).v) === 155000, await jl("cost_invoice", ciF));
    const ciF2 = await costInvoice(srcF, "TRANSPORT", 4000, d("03-21"), "credit_note", ciF);
    await post(ciF2);
    check("multiple deltas on one cost: a later credit 4,000 splits the same way (-2,000 / -2,000)",
      (await jl("cost_invoice", ciF2)) === "1150:0/2000 2110:4000/0 5100:0/2000" && n((await stock(bagF)).v) === 153000);

    // ------------------------------------------------------------ closed periods and catch-ups
    const bulkC = await bulkP("BLK7C");
    const bagC = await bagP("BAG7C", bulkC);
    const purC = await purchase(bagC, 100, 1000, d("01-05"));
    const saleC = await sale(bagC, 50, hq, d("01-10"));
    // split the seeded year period so January can be closed on its own
    await db.query("update accounting_periods set start_date=$2 where company_id=$1 and start_date <= $3 and end_date >= $3", [co, d("02-01"), d("01-15")]);
    await db.query("insert into accounting_periods(company_id, financial_year, name, start_date, end_date, status) values ($1,$2,'January',$3,$4,'closed')", [co, String(Y), d("01-01"), d("01-31")]);
    const srcC = await costSource(purC, "TRANSPORT", 0);
    check("a late cost cannot be backdated into the closed period", await (async () => {
      const x = await costInvoice(srcC, "TRANSPORT", 10000, d("01-20"));
      return fails(db, "select post_cost_invoice($1,$2,$3)", [x, owner, key()], "closed");
    })());
    const ciC = await costInvoice(srcC, "TRANSPORT", 10000, d("03-20"));
    await post(ciC);
    const rep = (await db.query<{ target: string; ref_number: string; catch_up: boolean; posting_date: string; amount: string }>(
      "select target, ref_number, catch_up, posting_date::text, amount::text from late_cost_report($1,$2,$3) where src_id=$4 order by target", [co, d("03-01"), d("03-31"), ciC])).rows;
    check("posted in the open period; the share of the January sale is reported as a catch-up with its document",
      rep.length === 2 && rep[0].target === "cogs" && rep[0].catch_up && rep[0].posting_date === d("03-20") && n(rep[0].amount) === 5000
      && rep[0].ref_number === (await one(db, "select document_number from sales where id=$1", [saleC])) && rep[1].target === "stock" && !rep[1].catch_up, JSON.stringify(rep));
    check("nothing was posted into January", Number(await one(db, "select count(*) from journal_entries where company_id=$1 and entry_date between $2 and $3 and source_type in ('cost_invoice','cost_accrual')", [co, d("01-01"), d("01-31")])) === 0);

    // ------------------------------------------------------------ reconciliation
    const checks = (await db.query<{ check_key: string; ok: boolean; detail: string; expected: string; actual: string }>("select * from cost_reconciliation_checks($1)", [co])).rows;
    for (const c of checks) check(`reconciliation: ${c.check_key}`, c.ok, `${c.expected} vs ${c.actual} (${c.detail})`);
    check("every invoice replaced its accrual exactly once: 2140 back to zero, supplier credit 1170 = 2,000 open", (await gl("2140")) === 0 && (await gl("1170")) === 2000);
    check("clearing accounts show only explained open items (one accrual: LOADING on purchase D is invoiced, no open accruals)",
      checks.find((c) => c.check_key === "accruals")?.detail === "no open accruals");
    check("app users cannot call adjustment functions",
      (await one<boolean>(db, "select has_function_privilege('authenticated','public.void_cost_invoice(uuid,uuid,text,text)','execute')")) === false
      && (await one<boolean>(db, "select has_function_privilege('authenticated','public.post_purchase_cost_adjustment(uuid,uuid,text)','execute')")) === false);

    console.log(`\n${passed} late-cost Stage 7 checks passed. Rolling back.`);
  } catch (e) {
    console.error("\nLate-cost Stage 7 test error:\n", e);
    process.exitCode = 1;
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main();
