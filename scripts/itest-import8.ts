/**
 * Import upgrade - Stage 8 (pricing and operational reports).
 * One transaction, ROLLED BACK. PGlite test database only (npm run test:db).
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-import8 runs only against the PGlite test database (npm run test:db).");
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
const key = () => `stage8-key-${++k}-${Math.random().toString(36).slice(2)}`;
const n = (x: unknown) => Number(x);
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

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
    const mwz = await one(db, "insert into branches(company_id, code, name) values ($1,'MWZ8','Mwanza') returning id", [co]);
    const kg = await one(db, "select id from units where company_id=$1 and code='KG'", [co]);
    const bag = await one(db, "select id from units where company_id=$1 and code='BAG'", [co]);
    const cash = await one(db, "select id from payment_accounts where company_id=$1 and code='CASH'", [co]);
    const walkin = await one(db, "select id from customers where company_id=$1 and code='WALK-IN'", [co]);
    await db.query("update feature_flags set is_enabled=true where company_id=$1 and flag_key in ('imports','rebagging','transfer_logistics')", [co]);
    const yara = await one(db, "insert into suppliers(company_id, code, name) values ($1,'YARA8','Yara') returning id", [co]);
    const bulk = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'UREA8','Urea bulk',$2,'bulk') returning id", [co, kg]);
    const b50 = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id, selling_price) values ($1,'UREA8-50','Urea 50 kg',$2,'packaged',50,$3,55000) returning id", [co, bag, bulk]);
    const cat = (code: string) => one(db, "select id from cost_categories where company_id=$1 and code=$2", [co, code]);
    const sale = async (prod: string, qty: number, price: number, br = hq, date = d("04-10")) => {
      const id = await one(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, grand_total) values ($1,$2,$3,$4,$5,$6) returning id",
        [co, br, date, walkin, owner, qty * price]);
      await db.query(`insert into sale_lines(sale_id, product_id, quantity, unit_price, net_amount, tax_amount, line_total, track_inventory, line_no)
                      values ($1,$2,$3,$4,$5,0,$5,true,1)`, [id, prod, qty, price, qty * price]);
      await db.query("insert into sale_payments(sale_id, payment_account_id, amount) values ($1,$2,$3)", [id, cash, qty * price]);
      await db.query("select post_sale($1,$2,null)", [id, owner]);
      return id;
    };

    // ------------------------------------------------------------ fixture: shipment → rebagging → transfer → sales
    const sh = await one(db, `insert into import_shipments(company_id, branch_id, supplier_id, incoterm, goods_includes_freight, goods_includes_insurance,
                 currency_code, named_place, ownership_event) values ($1,$2,$3,'CIF',true,true,'TZS','Dar es Salaam','bill_of_lading') returning id`, [co, hq, yara]);
    const sl = await one(db, "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg, fc_amount, line_no) values ($1,$2,$3,100000,100000,80000000,1) returning id", [co, sh, bulk]);
    const srcPort = await one(db, "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id, estimated_amount, description) values ($1,'import_shipment',$2,$3,10000000,'Port') returning id", [co, sh, await cat("PORT")]);
    const srcStore = await one(db, "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id, estimated_amount, description) values ($1,'import_shipment',$2,$3,2000000,'Storage') returning id", [co, sh, await cat("STORAGE")]);
    await db.query("select set_import_shipment_status($1,'dispatched',$2,$3)", [sh, d("04-01"), owner]);
    await db.query("select recognise_import_ownership($1,$2,null,$3,$4)", [sh, d("04-02"), owner, key()]);
    await db.query("select accrue_import_cost($1,10000000,$2,$3,$4)", [srcPort, d("04-02"), owner, key()]);
    await db.query("select accrue_import_cost($1,2000000,$2,$3,$4)", [srcStore, d("04-02"), owner, key()]);
    const rc = await one(db, "insert into import_receipts(company_id, shipment_id, branch_id, receipt_date) values ($1,$2,$3,$4) returning id", [co, sh, hq, d("04-03")]);
    await db.query("insert into import_receipt_lines(company_id, receipt_id, shipment_line_id, quantity_received, net_kg_received, is_final, line_no) values ($1,$2,$3,100000,100000,true,1)", [co, rc, sl]);
    await db.query("select post_import_receipt($1,$2,$3)", [rc, owner, key()]);
    const ro = await one(db, "insert into rebag_orders(company_id, branch_id, bulk_product_id, order_date) values ($1,$2,$3,$4) returning id", [co, hq, bulk, d("04-04")]);
    await db.query("insert into rebag_inputs(company_id, order_id, input_kind, product_id, quantity) values ($1,$2,'bulk',$3,10000)", [co, ro, bulk]);
    await db.query("insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg, line_no) values ($1,$2,$3,200,10000,1)", [co, ro, b50]);
    await db.query("insert into cost_sources(company_id, owner_type, rebag_order_id, cost_category_id, estimated_amount, description) values ($1,'rebag_order',$2,$3,100000,'Bag store')", [co, ro, await cat("STORAGE")]);
    await db.query("select complete_rebag_order($1,$2,$3)", [ro, owner, key()]);
    const tr = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id) values ($1,$2,$3) returning id", [co, hq, mwz]);
    const tl = await one(db, "insert into stock_transfer_lines(transfer_id, product_id, qty_requested) values ($1,$2,100) returning id", [tr, b50]);
    await db.query("select dispatch_stock_transfer($1,$2,$3)", [tr, owner, key()]);
    await db.query("select receive_stock_transfer($1,$2,$3::jsonb,$4)", [tr, owner, JSON.stringify([{ line_id: tl, qty: 100 }]), key()]);
    const sBulk = await sale(bulk, 20000, 1000);
    await sale(b50, 50, 60000);
    await sale(b50, 40, 62000, mwz);

    // ------------------------------------------------------------ commercial overhead (pricing only, never posted)
    const co8 = (await db.query<{ branch_id: string; product_id: string; per_kg: string }>("select branch_id, product_id, per_kg::text from commercial_overhead($1)", [co])).rows;
    const per = (br: string, p: string) => n(co8.find((r) => r.branch_id === br && r.product_id === p)?.per_kg ?? 0);
    check("storage 2M on 100,000 kg gives a commercial overhead of 20/kg on the bulk", near(per(hq, bulk), 20), JSON.stringify(co8));
    check("rebagged bags carry the bulk's 20/kg plus their own bag-store charge 100,000 / 10,000 kg = 30/kg (1,500 per 50 kg bag)", near(per(hq, b50), 30));
    check("transferred bags carry the sender's commercial overhead to Mwanza (30/kg)", near(per(mwz, b50), 30));
    const glBefore = n(await one(db, "select count(*) from journal_entries where company_id=$1", [co]));
    await db.query("select * from commercial_overhead($1)", [co]);
    check("computing commercial overhead posts nothing", n(await one(db, "select count(*) from journal_entries where company_id=$1", [co])) === glBefore);
    check("accounting cost of a bag stays at 45,000 (900/kg x 50; storage expensed, not in stock)", near(n(await one(db, "select avg_unit_cost from stock_balances where branch_id=$1 and product_id=$2", [hq, b50])), 45000));

    // ------------------------------------------------------------ trace and provenance profitability
    const mv = await one(db, "select movement_id from import_receipt_lines where receipt_id=$1", [rc]);
    const m = (await db.query<{ created_at: string; branch_id: string }>("select created_at, branch_id from stock_movements where id=$1", [mv])).rows[0];
    const t = (await db.query<{ kind: string; ref_id: string | null; branch_id: string; product_id: string; units: string }>(
      "select kind, ref_id, branch_id, product_id, units::text from trace_receipt_units($1,$2,$3,$4,$5,100000,0)", [co, hq, bulk, m.created_at, mv])).rows;
    const sum = (f: (r: typeof t[number]) => boolean) => t.filter(f).reduce((a, r) => a + n(r.units), 0);
    check("trace: 20,000 kg sold as bulk, 70,000 kg bulk held",
      near(sum((r) => r.kind === "sale" && r.product_id === bulk), 20000) && near(sum((r) => r.kind === "held" && r.product_id === bulk), 70000), JSON.stringify(t));
    check("trace follows rebagging and the transfer: 50 bags sold at HQ, 40 at Mwanza, 50 and 60 bags held",
      near(sum((r) => r.kind === "sale" && r.product_id === b50 && r.branch_id === hq), 50) && near(sum((r) => r.kind === "sale" && r.branch_id === mwz), 40)
      && near(sum((r) => r.kind === "held" && r.product_id === b50 && r.branch_id === hq), 50) && near(sum((r) => r.kind === "held" && r.branch_id === mwz), 60));
    const prov = (await db.query<{ product_id: string; branch_id: string; units: string; revenue: string; cogs: string }>(
      "select product_id, branch_id, sum(units)::text units, sum(revenue)::text revenue, sum(cogs)::text cogs from shipment_sales_trace($1,$2,$3) where shipment_id=$4 group by 1,2", [co, d("04-01"), d("04-30"), sh])).rows;
    const pBulk = prov.find((r) => r.product_id === bulk)!;
    check("shipment provenance (allocation): bulk 20,000 kg revenue 20M, cost of sales 18M at the blended 900/kg",
      near(n(pBulk.units), 20000) && near(n(pBulk.revenue), 20000000) && near(n(pBulk.cogs), 18000000), JSON.stringify(prov));
    check("shipment provenance covers the bags sold at both branches",
      near(n(prov.find((r) => r.product_id === b50 && r.branch_id === mwz)?.revenue ?? 0), 2480000) && near(n(prov.find((r) => r.product_id === b50 && r.branch_id === hq)?.revenue ?? 0), 3000000));

    // ------------------------------------------------------------ late cost in the report period
    const srcClr = await one(db, "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id, estimated_amount, description) values ($1,'import_shipment',$2,$3,0,'Clearing') returning id", [co, sh, await cat("CLEARING")]);
    const ci = await one(db, "insert into cost_invoices(company_id, branch_id, supplier_id, document_date, supplier_invoice_number) values ($1,$2,$3,$4,'CLR-8') returning id", [co, hq, yara, d("05-05")]);
    await db.query("insert into cost_invoice_lines(company_id, cost_invoice_id, cost_category_id, cost_source_id, net_amount) values ($1,$2,$3,$4,1000000)", [co, ci, await cat("CLEARING"), srcClr]);
    await db.query("select post_cost_invoice($1,$2,$3)", [ci, owner, key()]);
    const prof = async (from: string, to: string) => (await db.query<{ branch_id: string; product_id: string; qty_sold: string; revenue: string; cogs: string; late_cost: string }>(
      "select branch_id, product_id, qty_sold::text, revenue::text, cogs::text, late_cost::text from sales_profitability($1,$2,$3)", [co, from, to])).rows;
    const april = await prof(d("04-01"), d("04-30")), may = await prof(d("05-01"), d("05-31"));
    const row = (rs: typeof april, br: string, p: string) => rs.find((r) => r.branch_id === br && r.product_id === p);
    check("April profitability: sales and cost of sales at sale (bulk 20M / 18M; HQ bags 3M / 2.25M; Mwanza bags 2.48M / 1.8M)",
      near(n(row(april, hq, bulk)?.revenue), 20000000) && near(n(row(april, hq, bulk)?.cogs), 18000000) && near(n(row(april, hq, b50)?.cogs), 2250000)
      && near(n(row(april, mwz, b50)?.cogs), 1800000) && n(row(april, hq, bulk)?.late_cost) === 0, JSON.stringify(april));
    check("the late clearing cost (posted 5 May) is in May's report: bulk 200k, HQ bags 25k, Mwanza bags 20k — not in April",
      near(n(row(may, hq, bulk)?.late_cost), 200000) && near(n(row(may, hq, b50)?.late_cost), 25000) && near(n(row(may, mwz, b50)?.late_cost), 20000)
      && n(row(may, hq, bulk)?.revenue) === 0, JSON.stringify(may));
    void sBulk;

    // ------------------------------------------------------------ approved price changes
    const dir = await one(db, "insert into auth.users(email) values ('dir8@test.local') returning id");
    await db.query(`insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active) values ($1,'dir8@test.local','D',(select id from roles where code='DIRECTOR'),$2,true)`, [dir, co]);
    await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [dir, co]);
    check("only the Owner changes an approved selling price", await fails(db, "select set_product_selling_price($1,$2,62500,'{}'::jsonb,'x',$3)", [b50, dir, key()], "only the owner"));
    check("negative / 3-decimal prices refused", await fails(db, "select set_product_selling_price($1,$2,-1,'{}'::jsonb,'x',$3)", [b50, owner, key()])
      && await fails(db, "select set_product_selling_price($1,$2,1.234,'{}'::jsonb,'x',$3)", [b50, owner, key()]));
    const avgBefore = n(await one(db, "select avg_unit_cost from stock_balances where branch_id=$1 and product_id=$2", [hq, b50]));
    const jBefore = Number(await one(db, "select count(*) from journal_entries where company_id=$1", [co]));
    const kp = key();
    const basis = { accounting_cost: 48500, commercial_overhead: 1500, mode: "margin", rate: 20, suggested: 62500 };
    await db.query("select set_product_selling_price($1,$2,62500,$3::jsonb,'margin review',$4)", [b50, owner, JSON.stringify(basis), kp]);
    await db.query("select set_product_selling_price($1,$2,62500,$3::jsonb,'margin review',$4)", [b50, owner, JSON.stringify(basis), kp]);
    check("price change recorded once with old / new price and its costing basis",
      (await one(db, "select old_price || '>' || new_price || '|' || (basis->>'mode') || '|' || reason from product_price_changes where product_id=$1", [b50])) === "55000.00>62500.00|margin|margin review"
      && Number(await one(db, "select count(*) from product_price_changes where product_id=$1", [b50])) === 1
      && n(await one(db, "select selling_price from products where id=$1", [b50])) === 62500);
    check("changing the price does not touch inventory cost or post anything",
      n(await one(db, "select avg_unit_cost from stock_balances where branch_id=$1 and product_id=$2", [hq, b50])) === avgBefore
      && Number(await one(db, "select count(*) from journal_entries where company_id=$1", [co])) === jBefore);
    check("price history is immutable", await fails(db, "update product_price_changes set new_price=1 where product_id=$1", [b50]));
    check("app users cannot call pricing / report functions directly",
      (await one<boolean>(db, "select has_function_privilege('authenticated','public.set_product_selling_price(uuid,uuid,numeric,jsonb,text,text)','execute')")) === false
      && (await one<boolean>(db, "select has_function_privilege('authenticated','public.commercial_overhead(uuid)','execute')")) === false);

    console.log(`\n${passed} pricing & reports Stage 8 checks passed. Rolling back.`);
  } catch (e) {
    console.error("\nStage 8 test error:\n", e);
    process.exitCode = 1;
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main();
