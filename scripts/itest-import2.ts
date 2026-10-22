/**
 * Import upgrade - Stage 2 (foundations and secure posting) checks.
 * One transaction, ROLLED BACK. PGlite test database only (npm run test:db).
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-import2 runs only against the PGlite test database (npm run test:db).");
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
const key = () => `test-key-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    // ------------------------------------------------------------ fixtures
    const co = await one(db, "select id from companies where code='LETIQ'");
    const owner = await one(db, "select id from user_profiles where is_primary_owner");
    const hq = await one(db, "select id from branches where company_id=$1 and code='HQ'", [co]);
    const mwz = await one(db, "insert into branches(company_id, code, name) values ($1,'MWZ','Mwanza') returning id", [co]);
    const aru = await one(db, "insert into branches(company_id, code, name) values ($1,'ARU','Arusha') returning id", [co]);
    const unit = (code: string, c = co) => one(db, "select id from units where company_id=$1 and code=$2", [c, code]);
    const kg = await unit("KG"), bag = await unit("BAG");
    const sup = await one(db, "insert into suppliers(company_id, code, name) values ($1,'YARA','Yara Intl') returning id", [co]);
    const bulk = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'UREA-B','Urea bulk',$2,'bulk') returning id", [co, kg]);
    const p50 = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id) values ($1,'UREA-50','Urea 50kg',$2,'packaged',50,$3) returning id", [co, bag, bulk]);
    const p25 = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id) values ($1,'UREA-25','Urea 25kg',$2,'packaged',25,$3) returning id", [co, bag, bulk]);
    const bag50 = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'EBAG-50','Empty bag 50kg',$2,'packaging_material') returning id", [co, bag]);
    const cat = (code: string, c = co) => one(db, "select id from cost_categories where company_id=$1 and code=$2", [c, code]);

    // Users: storekeeper at HQ only, director at HQ + MWZ, outsider (no company).
    const mkUser = async (email: string, role: string, branches: string[], company: string | null = co) => {
      const id = await one(db, "insert into auth.users(email) values ($1) returning id", [email]);
      await db.query(`insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active)
                      values ($1,$2,$2,(select id from roles where code=$3),$4,true)`, [id, email, role, company]);
      if (company) await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [id, company]);
      for (const b of branches) await db.query("insert into user_branch_access(user_id, branch_id) values ($1,$2)", [id, b]);
      return id;
    };
    const keeper = await mkUser("keeper@test.local", "STOREKEEPER", [hq]);
    const director = await mkUser("director@test.local", "DIRECTOR", [hq, mwz]);
    const aruKeeper = await mkUser("aru@test.local", "STOREKEEPER", [aru]);

    // Second company with its own master data (for guessed-ID attacks).
    const co2 = await one(db, "insert into companies(code, name) values ('OTHER','Other Co') returning id");
    await db.query("insert into branches(company_id, code, name) values ($1,'HQ','Other HQ')", [co2]);
    await db.query("insert into units(company_id, code, name, kg_factor) values ($1,'KG','Kilogram',1)", [co2]);
    await db.query(`insert into chart_of_accounts(company_id, code, name, account_type, normal_balance) values
      ($1,'1000','Assets','asset','debit'),($1,'1100','Current','asset','debit'),($1,'1150','Inventory','asset','debit'),
      ($1,'2000','Liab','liability','credit'),($1,'2100','Current liab','liability','credit'),($1,'2110','AP','liability','credit'),
      ($1,'3000','Equity','equity','credit'),($1,'4000','Revenue','revenue','credit'),($1,'5000','COS','cost_of_sales','debit'),
      ($1,'5100','COGS','cost_of_sales','debit'),($1,'6000','Expenses','expense','debit'),($1,'6100','Opex','expense','debit'),
      ($1,'6200','Bank charges','expense','debit'),($1,'1120','Bank','asset','debit'),($1,'1130','Mobile','asset','debit'),
      ($1,'1160','VAT in','asset','debit')`, [co2]);
    await db.query("select ensure_company_defaults($1)", [co2]);
    const sup2 = await one(db, "insert into suppliers(company_id, code, name) values ($1,'S2','Other supplier') returning id", [co2]);
    const prod2 = await one(db, "insert into products(company_id, sku, name, base_unit_id, stock_role) values ($1,'X-B','Other bulk',$2,'bulk') returning id", [co2, await unit("KG", co2)]);
    const acc2 = await one(db, "select id from chart_of_accounts where company_id=$1 and code='6100'", [co2]);

    // ------------------------------------------------------------ allocation engine
    const alloc = async (total: string, basis: string, targets: unknown[]) =>
      (await db.query<{ target_id: string; amount: string }>(
        "select target_id, amount::text from allocate_amount($1::numeric,$2,$3::jsonb) order by target_id", [total, basis, JSON.stringify(targets)])).rows;
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
    const sum = (rows: { amount: string }[]) => rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);
    const thirds = await alloc("100.00", "weight", ids.map((id) => ({ id, factor: 1 })));
    check("100.00 over three equal weights sums exactly", sum(thirds) === 10000);
    check("remainder goes to one target deterministically (33.34/33.33/33.33)",
      thirds.map((r) => r.amount).sort().join(",") === "33.33,33.33,33.34");
    check("same input -> same result", JSON.stringify(thirds) === JSON.stringify(await alloc("100.00", "weight", ids.map((id) => ({ id, factor: 1 })))));
    check("negative total (credit) conserved", sum(await alloc("-100.00", "value", ids.map((id, i) => ({ id, factor: i + 1 })))) === -10000);
    const pct = await alloc("1000.00", "percent", [{ id: ids[0], percent: 50 }, { id: ids[1], percent: 30 }, { id: ids[2], percent: 20 }]);
    check("percent 50/30/20", pct.map((r) => r.amount).join(",") === "500.00,300.00,200.00");
    check("percentages must total 100", await fails(db, "select * from allocate_amount(10,'percent',$1::jsonb)",
      [JSON.stringify([{ id: ids[0], percent: 50 }, { id: ids[1], percent: 49.99 }])], "total exactly 100"));
    check("percentage above 100 rejected", await fails(db, "select * from allocate_amount(10,'percent',$1::jsonb)",
      [JSON.stringify([{ id: ids[0], percent: 120 }, { id: ids[1], percent: -20 }])], "between 0 and 100"));
    check("manual amounts must equal the total", await fails(db, "select * from allocate_amount(100,'manual',$1::jsonb)",
      [JSON.stringify([{ id: ids[0], amount: 60 }, { id: ids[1], amount: 30 }])], "must equal"));
    check("manual amounts accepted when exact", sum(await alloc("100.00", "manual", [{ id: ids[0], amount: 60.5 }, { id: ids[1], amount: 39.5 }])) === 10000);
    check("zero denominator rejected", await fails(db, "select * from allocate_amount(100,'weight',$1::jsonb)",
      [JSON.stringify(ids.map((id) => ({ id, factor: 0 })))], "total zero"));
    check("negative factor rejected", await fails(db, "select * from allocate_amount(100,'weight',$1::jsonb)",
      [JSON.stringify([{ id: ids[0], factor: 5 }, { id: ids[1], factor: -1 }])], "negative"));
    check("missing volume figure rejected", await fails(db, "select * from allocate_amount(100,'volume',$1::jsonb)",
      [JSON.stringify([{ id: ids[0], factor: 5 }, { id: ids[1] }])], "needs a volume"));
    check("duplicate targets rejected", await fails(db, "select * from allocate_amount(100,'weight',$1::jsonb)",
      [JSON.stringify([{ id: ids[0], factor: 1 }, { id: ids[0], factor: 1 }])], "distinct"));
    check("direct needs exactly one target", await fails(db, "select * from allocate_amount(100,'direct',$1::jsonb)",
      [JSON.stringify([{ id: ids[0] }, { id: ids[1] }])], "exactly one"));
    check("3-decimal total rejected", await fails(db, "select * from allocate_amount(100.005,'direct',$1::jsonb)", [JSON.stringify([{ id: ids[0] }])]));
    // Property test: random totals and factors always conserve and stay within a cent of the exact share.
    let propOk = true; let propDetail = "";
    for (let i = 0; i < 300 && propOk; i++) {
      const n = 1 + Math.floor(Math.random() * 12);
      const targets = Array.from({ length: n }, (_, j) => ({ id: `00000000-0000-4000-8000-${String(j + 1).padStart(12, "0")}`, factor: Math.floor(Math.random() * 100000) / 100 }));
      if (targets.every((t) => t.factor === 0)) targets[0].factor = 1;
      const cents = Math.floor(Math.random() * 1e11) * (Math.random() < 0.2 ? -1 : 1);
      const total = (cents / 100).toFixed(2);
      const rows = await alloc(total, "weight", targets);
      const fsum = targets.reduce((s, t) => s + t.factor, 0);
      const within = rows.every((r) => {
        const f = targets.find((t) => t.id === r.target_id)!.factor;
        return Math.abs(Number(r.amount) * 100 - (cents * f) / fsum) <= 1.0000001;
      });
      if (sum(rows) !== cents || !within) { propOk = false; propDetail = `${total} over ${JSON.stringify(targets)}`; }
    }
    check("300 random allocations conserve totals within one cent per target", propOk, propDetail);

    // ------------------------------------------------------------ validation / precision
    const ship = await one(db, `insert into import_shipments(company_id, branch_id, supplier_id, incoterm, goods_includes_freight, goods_includes_insurance, currency_code, bill_of_lading)
                                values ($1,$2,$3,'CIF',true,true,'USD','BL-001') returning id`, [co, hq, sup]);
    const fob = await one(db, `insert into import_shipments(company_id, branch_id, supplier_id, incoterm, goods_includes_freight, goods_includes_insurance, currency_code)
                               values ($1,$2,$3,'FOB',false,false,'USD') returning id`, [co, hq, sup]);
    check("duplicate bill of lading rejected", await fails(db,
      `insert into import_shipments(company_id, branch_id, supplier_id, incoterm, goods_includes_freight, goods_includes_insurance, bill_of_lading)
       values ($1,$2,$3,'CIF',true,true,' bl-001 ')`, [co, hq, sup]));
    const sl1 = await one(db, `insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg, volume_m3, fc_amount)
                               values ($1,$2,$3,600000,600000,800,252000) returning id`, [co, ship, bulk]);
    await one(db, `insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg, volume_m3, fc_amount)
                               values ($1,$2,$3,400000,400000,500,168000) returning id`, [co, ship, bulk]);
    check("shipment line net kg must be positive", await fails(db,
      "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg) values ($1,$2,$3,1,0)", [co, ship, bulk]));
    check("gross kg below net kg rejected", await fails(db,
      "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg, gross_kg) values ($1,$2,$3,1,10,9)", [co, ship, bulk]));
    check("negative FC amount rejected", await fails(db,
      "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg, fc_amount) values ($1,$2,$3,1,1,-5)", [co, ship, bulk]));
    // (Stage 3 allows purchase-origin foreign invoices; import-only posting mode still needs a shipment.)
    check("invoice-only purchase needs an import shipment", await fails(db,
      "insert into purchases(company_id, branch_id, supplier_id, currency_code, exchange_rate, posting_mode) values ($1,$2,$3,'USD',2500,'invoice_only')", [co, hq, sup]));
    check("zero exchange rate rejected", await fails(db,
      "insert into purchases(company_id, branch_id, supplier_id, currency_code, exchange_rate, import_shipment_id, posting_mode) values ($1,$2,$3,'USD',0,$4,'invoice_only')", [co, hq, sup, ship]));
    check("TZS purchase cannot carry a rate", await fails(db,
      "insert into purchases(company_id, branch_id, supplier_id, exchange_rate) values ($1,$2,$3,2)", [co, hq, sup]));
    const gi = await one(db, `insert into purchases(company_id, branch_id, supplier_id, currency_code, exchange_rate, import_shipment_id, posting_mode, supplier_invoice_number)
                              values ($1,$2,$3,'USD',2500,$4,'invoice_only','YARA-INV-9') returning id`, [co, hq, sup, ship]);
    check("goods invoice currency must match the shipment", await fails(db,
      "insert into purchases(company_id, branch_id, supplier_id, currency_code, exchange_rate, import_shipment_id, posting_mode) values ($1,$2,$3,'EUR',2900,$4,'invoice_only')", [co, hq, sup, ship]));
    await db.query("insert into purchase_lines(purchase_id, product_id, quantity, unit_cost, import_shipment_line_id, fc_unit_cost) values ($1,$2,600000,1050,$3,0.42)", [gi, bulk, sl1]);
    check("invoice-only purchase cannot be posted by the legacy path", await fails(db,
      "update purchases set document_status='posted' where id=$1", [gi], "import workflow"));
    check("purchase line must reference its own shipment's line", await fails(db,
      "insert into purchase_lines(purchase_id, product_id, quantity, unit_cost, import_shipment_line_id) values ($1,$2,1,1,(select id from import_shipment_lines where shipment_id=$3 limit 1))",
      [gi, bulk, ship]) === false); // same shipment -> allowed (control)
    const fobLine = await one(db, "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg) values ($1,$2,$3,1,1) returning id", [co, fob, bulk]);
    check("purchase line referencing another shipment's line rejected", await fails(db,
      "insert into purchase_lines(purchase_id, product_id, quantity, unit_cost, import_shipment_line_id) values ($1,$2,1,1,$3)", [gi, bulk, fobLine], "own shipment"));

    // Cost sources and snapshots.
    check("freight cannot be added to a CIF shipment", await fails(db,
      "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id) values ($1,'import_shipment',$2,$3)", [co, ship, await cat("FREIGHT")], "already includes freight"));
    check("freight allowed on an FOB shipment", await fails(db,
      "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id) values ($1,'import_shipment',$2,$3)", [co, fob, await cat("FREIGHT")]) === false);
    check("goods value is not a cost source", await fails(db,
      "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id) values ($1,'import_shipment',$2,$3)", [co, ship, await cat("GOODS")], "goods invoice"));
    check("negative estimate rejected", await fails(db,
      "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id, estimated_amount) values ($1,'import_shipment',$2,$3,-1)", [co, ship, await cat("PORT")]));
    check("category must apply to the workflow", await fails(db,
      "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id) values ($1,'import_shipment',$2,$3)", [co, ship, await cat("TRANSPORT")], "does not apply"));
    const storage = await one(db, "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id, estimated_amount) values ($1,'import_shipment',$2,$3,3000000) returning id", [co, ship, await cat("STORAGE")]);
    check("snapshot copies the category treatment", (await one(db, "select inventory_treatment from cost_sources where id=$1", [storage])) === "expense");
    await db.query("update cost_sources set status='accrued', accrued_amount=3000000 where id=$1", [storage]);
    await db.query("update cost_categories set inventory_treatment='capitalize', expense_account_id=null where id=$1", [await cat("STORAGE")]);
    check("changing the category default does not change the accrued source",
      (await one(db, "select inventory_treatment || ':' || (expense_account_id is not null) from cost_sources where id=$1", [storage])) === "expense:true");
    check("snapshot of an accrued source cannot be edited", await fails(db,
      "update cost_sources set inventory_treatment='capitalize', expense_account_id=null where id=$1", [storage], "frozen"));
    const port = await one(db, "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id, estimated_amount) values ($1,'import_shipment',$2,$3,15000000) returning id", [co, ship, await cat("PORT")]);

    // Credit notes, posted invoices.
    const ci = await one(db, "insert into cost_invoices(company_id, branch_id, supplier_id, net_total, grand_total) values ($1,$2,$3,100,100) returning id", [co, hq, sup]);
    check("credit note must name the credited invoice", await fails(db,
      "insert into cost_invoices(company_id, branch_id, supplier_id, document_kind) values ($1,$2,$3,'credit_note')", [co, hq, sup]));
    const sup3 = await one(db, "insert into suppliers(company_id, code, name) values ($1,'PORT','Port authority') returning id", [co]);
    check("credit note must credit the same supplier", await fails(db,
      "insert into cost_invoices(company_id, branch_id, supplier_id, document_kind, credited_invoice_id) values ($1,$2,$3,'credit_note',$4)", [co, hq, sup3, ci], "same supplier"));
    check("negative cost invoice total rejected", await fails(db,
      "insert into cost_invoices(company_id, branch_id, supplier_id, net_total) values ($1,$2,$3,-10)", [co, hq, sup]));
    await db.query("update cost_invoices set document_status='posted' where id=$1", [ci]);
    check("posted cost invoice cannot be edited", await fails(db, "update cost_invoices set net_total=50 where id=$1", [ci], "credit note"));

    // Packages and rebagging lineage.
    check("packaged product needs a whole-number unit", await fails(db,
      "insert into products(company_id, sku, name, base_unit_id, stock_role, net_weight_kg, bulk_product_id) values ($1,'BAD-P','x',$2,'packaged',5,$3)", [co, kg, bulk], "whole-number"));
    const ro = await one(db, "insert into rebag_orders(company_id, branch_id, bulk_product_id) values ($1,$2,$3) returning id", [co, hq, bulk]);
    check("rebag order must consume a bulk product", await fails(db,
      "insert into rebag_orders(company_id, branch_id, bulk_product_id) values ($1,$2,$3)", [co, hq, p50]));
    const out50 = await one(db, "insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg) values ($1,$2,$3,6000,300000) returning id", [co, ro, p50]);
    await db.query("insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg) values ($1,$2,$3,3000,75000)", [co, ro, p25]);
    check("fractional bag count rejected", await fails(db,
      "insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg) values ($1,$2,$3,10.5,525)", [co, ro, p50]));
    check("output kg must equal bags x pack weight", await fails(db,
      "insert into rebag_outputs(company_id, order_id, product_id, bags, net_kg) values ($1,$2,$3,10,499)", [co, ro, p50], "bags x"));
    // Stage 5: packaging may be common to all outputs (thread, labels); a bulk line can never target an output.
    check("bulk input cannot target an output", await fails(db,
      "insert into rebag_inputs(company_id, order_id, input_kind, product_id, quantity, target_output_id) values ($1,$2,'bulk',(select bulk_product_id from rebag_orders where id=$2),10,$3)", [co, ro, out50]));
    check("packaging input aimed at its output accepted", await fails(db,
      "insert into rebag_inputs(company_id, order_id, input_kind, product_id, quantity, target_output_id) values ($1,$2,'packaging',$3,6000,$4)", [co, ro, bag50, out50]) === false);
    check("bulk input must be the order's bulk product", await fails(db,
      "insert into rebag_inputs(company_id, order_id, input_kind, product_id, quantity) values ($1,$2,'bulk',$3,10)", [co, ro, p50]));

    // ------------------------------------------------------------ cross-company (guessed ids)
    check("shipment with another company's supplier rejected", await fails(db,
      "insert into import_shipments(company_id, branch_id, supplier_id, incoterm, goods_includes_freight, goods_includes_insurance) values ($1,$2,$3,'CIF',true,true)", [co, hq, sup2], "cross-company"));
    check("shipment line with another company's product rejected", await fails(db,
      "insert into import_shipment_lines(company_id, shipment_id, product_id, quantity, net_kg) values ($1,$2,$3,1,1)", [co, ship, prod2], "cross-company"));
    check("purchase linked to another company's shipment rejected", await fails(db,
      "insert into purchases(company_id, branch_id, supplier_id, import_shipment_id, posting_mode) values ($1,(select id from branches where company_id=$1 limit 1),$2,$3,'invoice_only')", [co2, sup2, ship], "cross-company"));
    check("cost source using another company's category rejected", await fails(db,
      "insert into cost_sources(company_id, owner_type, import_shipment_id, cost_category_id) values ($1,'import_shipment',$2,$3)", [co, ship, await cat("PORT", co2)], "cross-company"));
    check("cost invoice line pointing at another company's invoice and cost source rejected", await fails(db,
      "insert into cost_invoice_lines(company_id, cost_invoice_id, cost_category_id, cost_source_id, net_amount) values ($1,$2,$3,$4,1)",
      [co2, ci, await cat("PORT", co2), port], "cross-company"));
    check("account mapping to another company's account rejected", await fails(db,
      "update account_mappings set account_id=$2 where company_id=$1 and mapping_key='inventory.loss'", [co, acc2], "cross-company"));
    check("journal using another company's account rejected", await fails(db,
      "select post_balanced_journal($1,$2,current_date,'test',gen_random_uuid(),'T','t',$3,$4::jsonb)",
      [co, hq, owner, JSON.stringify([{ account_id: acc2, debit: 10, credit: 0 }, { account_id: await one(db, "select account_for($1,'payables.trade')", [co]), debit: 0, credit: 10 }])], "does not belong"));
    check("stock lock with another company's product rejected", await fails(db,
      "select lock_stock_balances($1,$2::jsonb)", [co, JSON.stringify([{ branch_id: hq, product_id: prod2 }])], "does not belong"));
    const tr = await one(db, "insert into stock_transfers(company_id, source_branch_id, destination_branch_id) values ($1,$2,$3) returning id", [co, hq, mwz]);
    check("transfer line with another company's product rejected", await fails(db,
      "insert into stock_transfer_lines(transfer_id, product_id, qty_requested) values ($1,$2,1)", [tr, prod2]));
    await db.query("insert into stock_transfer_lines(transfer_id, product_id, qty_requested) values ($1,$2,100)", [tr, p50]);

    // ------------------------------------------------------------ direct API / permissions / flags
    for (const fn of ["allocate_cost_source(uuid,text,numeric,text,jsonb,uuid,text)", "post_balanced_journal(uuid,uuid,date,text,uuid,text,text,uuid,jsonb)",
      "register_attachment(uuid,text,uuid,text,text,text,text,text,bigint,text,uuid)", "claim_operation(text,text,uuid)",
      "assert_actor(uuid,uuid,text,uuid)", "lock_stock_balances(uuid,jsonb)", "allocate_amount(numeric,text,jsonb)", "account_for(uuid,text)"]) {
      check(`app users cannot execute ${fn.split("(")[0]}`,
        (await one<boolean>(db, `select has_function_privilege('authenticated','public.${fn}','execute')`)) === false
        && (await one<boolean>(db, `select has_function_privilege('anon','public.${fn}','execute')`)) === false);
    }
    const asRole = async (uid: string, sql: string) => {
      await db.query("savepoint r");
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      await db.query("set local role authenticated");
      try { const r = await db.query(sql); await db.query("rollback to savepoint r"); return { ok: true, rows: r.rows }; }
      catch (e) { await db.query("rollback to savepoint r"); return { ok: false, error: (e as Error).message }; }
    };
    check("signed-in client cannot insert shipments directly", !(await asRole(owner,
      `insert into import_shipments(company_id, branch_id, supplier_id, incoterm, goods_includes_freight, goods_includes_insurance) values ('${co}','${hq}','${sup}','CIF',true,true)`)).ok);
    check("signed-in client cannot write allocations directly", !(await asRole(owner,
      `insert into cost_allocations(company_id, run_id, target_type, target_id, amount) values ('${co}', gen_random_uuid(), 'import_shipment_line', gen_random_uuid(), 1)`)).ok);
    check("signed-in client cannot call the allocation RPC", !(await asRole(owner,
      `select allocate_cost_source('${port}','estimated',1,'weight',null,'${owner}','abcdefghijklmnopqrstu')`)).ok);
    const otherCoUser = await mkUser("othercompany@test.local", "DIRECTOR", [], co2);
    check("user of another company sees none of these shipments", ((await asRole(otherCoUser, "select id from import_shipments")).rows ?? []).length === 0);

    check("feature flag off blocks allocation", await fails(db,
      "select allocate_cost_source($1,'estimated',15000000,'weight',null,$2,$3)", [port, owner, key()], "not enabled"));
    await db.query("update feature_flags set is_enabled=true where company_id=$1 and flag_key in ('imports','attachments','transfer_logistics')", [co]);
    check("storekeeper lacks permission to allocate", await fails(db,
      "select allocate_cost_source($1,'estimated',15000000,'weight',null,$2,$3)", [port, keeper, key()], "missing permission"));
    check("user without company access denied", await fails(db,
      "select allocate_cost_source($1,'estimated',15000000,'weight',null,$2,$3)", [port, otherCoUser, key()], "company"));
    await db.query("update user_profiles set is_active=false where id=$1", [director]);
    check("inactive user denied", await fails(db,
      "select allocate_cost_source($1,'estimated',15000000,'weight',null,$2,$3)", [port, director, key()], "inactive"));
    await db.query("update user_profiles set is_active=true where id=$1", [director]);

    // ------------------------------------------------------------ allocation runs + idempotency
    const k1 = key();
    const run1 = await one(db, "select allocate_cost_source($1,'estimated',15000000,'weight',null,$2,$3)", [port, director, k1]);
    const run1again = await one(db, "select allocate_cost_source($1,'estimated',15000000,'weight',null,$2,$3)", [port, director, k1]);
    check("retry with the same key returns the same run", run1 === run1again);
    check("retry created no second run", Number(await one(db, "select count(*) from cost_allocation_runs where cost_source_id=$1", [port])) === 1);
    const byWeight = (await db.query<{ amount: string }>("select amount::text from cost_allocations where run_id=$1 order by amount desc", [run1])).rows.map((r) => r.amount);
    check("weight allocation 60/40 of 15,000,000", byWeight.join(",") === "9000000.00,6000000.00", byWeight.join(","));
    const run2 = await one(db, "select allocate_cost_source($1,'estimated',15000000.01,'volume',null,$2,$3)", [port, director, key()]);
    check("re-allocation supersedes the previous run",
      (await one(db, "select string_agg(is_current::text, ',' order by created_at, id) from cost_allocation_runs where cost_source_id=$1", [port])).split(",").filter((x) => x === "true").length === 1
      && run2 !== run1);
    check("volume allocation conserves 15,000,000.01",
      (await one(db, "select sum(amount)::text from cost_allocations where run_id=$1", [run2])) === "15000000.01");
    check("allocating to another shipment's lines rejected", await fails(db,
      "select allocate_cost_source($1,'estimated',100,'manual',$2::jsonb,$3,$4)", [port, JSON.stringify([{ id: fobLine, amount: 100 }]), director, key()], "do not belong"));
    check("expensed cost cannot be allocated to stock", await fails(db,
      "select allocate_cost_source($1,'accrued',3000000,'weight',null,$2,$3)", [storage, director, key()], "not allocated"));
    check("allocations are immutable", await fails(db, "update cost_allocations set amount=0 where run_id=$1", [run1], "cannot be changed"));
    check("allocation runs cannot be deleted", await fails(db, "delete from cost_allocation_runs where id=$1", [run1]));
    check("a superseded run cannot become current again", await fails(db, "update cost_allocation_runs set is_current=true where id=$1", [run1]));
    check("short idempotency key rejected", await fails(db, "select claim_operation('abc','x',null)", [], "at least 16"));
    const k2 = key();
    check("first claim succeeds", (await one<boolean>(db, "select claim_operation($1,'post_x',$2)", [k2, ship])) === true);
    check("replay reports already processed", (await one<boolean>(db, "select claim_operation($1,'post_x',$2)", [k2, ship])) === false);
    check("key reused for another operation rejected", await fails(db, "select claim_operation($1,'post_y',$2)", [k2, ship], "different operation"));

    // Supplier-invoice registry.
    await db.query("select register_supplier_invoice($1,$2,'YARA-INV-9','purchase',$3)", [co, sup, gi]);
    check("re-registering the same document is idempotent", await fails(db, "select register_supplier_invoice($1,$2,'yara inv 9','purchase',$3)", [co, sup, gi]) === false);
    check("same supplier invoice on a cost invoice rejected", await fails(db,
      "select register_supplier_invoice($1,$2,'Yara/Inv-9','cost_invoice',$3)", [co, sup, ci], "already recorded"));
    check("same number from a different supplier is fine", await fails(db,
      "select register_supplier_invoice($1,$2,'YARA-INV-9','cost_invoice',$3)", [co, sup3, ci]) === false);

    // ------------------------------------------------------------ journals and periods
    const ap = await one(db, "select account_for($1,'payables.trade')", [co]);
    const inv = await one(db, "select account_for($1,'inventory.bulk')", [co]);
    check("balanced journal posts", !!(await one(db, "select post_balanced_journal($1,$2,current_date,'test',gen_random_uuid(),'T','t',$3,$4::jsonb)",
      [co, hq, owner, JSON.stringify([{ account_id: inv, debit: 100.5, credit: 0 }, { account_id: ap, debit: 0, credit: 100.5 }])])));
    check("unbalanced journal rejected", await fails(db, "select post_balanced_journal($1,$2,current_date,'test',gen_random_uuid(),'T','t',$3,$4::jsonb)",
      [co, hq, owner, JSON.stringify([{ account_id: inv, debit: 100, credit: 0 }, { account_id: ap, debit: 0, credit: 99 }])], "not balanced"));
    check("3-decimal journal amount rejected", await fails(db, "select post_balanced_journal($1,$2,current_date,'test',gen_random_uuid(),'T','t',$3,$4::jsonb)",
      [co, hq, owner, JSON.stringify([{ account_id: inv, debit: 1.005, credit: 0 }, { account_id: ap, debit: 0, credit: 1.005 }])], "2 decimals"));
    check("header (non-posting) account rejected", await fails(db, "select post_balanced_journal($1,$2,current_date,'test',gen_random_uuid(),'T','t',$3,$4::jsonb)",
      [co, hq, owner, JSON.stringify([{ account_id: await one(db, "select id from chart_of_accounts where company_id=$1 and code='1000'", [co]), debit: 1, credit: 0 }, { account_id: ap, debit: 0, credit: 1 }])], "posting account"));
    await db.query("insert into accounting_periods(company_id, financial_year, name, start_date, end_date, status) values ($1,'2020','FY 2020','2020-01-01','2020-12-31','closed')", [co]);
    check("closed period rejected", await fails(db, "select post_balanced_journal($1,$2,'2020-06-30','test',gen_random_uuid(),'T','t',$3,$4::jsonb)",
      [co, hq, owner, JSON.stringify([{ account_id: inv, debit: 1, credit: 0 }, { account_id: ap, debit: 0, credit: 1 }])], "closed or locked"));
    check("account mapping needs the right account type", await fails(db,
      "update account_mappings set account_id=(select id from chart_of_accounts where company_id=$1 and code='6400') where company_id=$1 and mapping_key='fx.realised_gain'", [co], "needs a revenue"));
    check("19 mappings and 5 flags per company",
      Number(await one(db, "select count(*) from account_mappings where company_id=$1", [co])) === 19
      && Number(await one(db, "select count(*) from feature_flags where company_id=$1", [co2])) === 5
      && Number(await one(db, "select count(*) from feature_flags where company_id=$1 and is_enabled", [co2])) === 0);

    // ------------------------------------------------------------ attachments metadata
    const path = (ownerType: string, ownerId: string, c = co) => `${c}/${ownerType}/${ownerId}/${crypto.randomUUID()}.pdf`;
    const sha = "a".repeat(64);
    const reg = (user: string, ownerType: string, ownerId: string, category: string, p: string, type = "application/pdf", size = 1000, sup?: string) =>
      db.query("select register_attachment($1,$2,$3,$4,$5,'Bill of lading.pdf','Bill of lading.pdf',$6,$7,$8,$9) id",
        [user, ownerType, ownerId, category, p, type, size, sha, sup ?? null]);
    const att1 = (await reg(director, "import_shipment", ship, "bill_of_lading", path("import_shipment", ship))).rows[0].id as string;
    check("attachment registered as version 1", Number(await one(db, "select version from document_attachments where id=$1", [att1])) === 1);
    const att2 = (await reg(director, "import_shipment", ship, "bill_of_lading", path("import_shipment", ship), "application/pdf", 1000, att1)).rows[0].id as string;
    check("replacement is version 2 superseding version 1", Number(await one(db, "select version from document_attachments where id=$1", [att2])) === 2);
    check("a version cannot be superseded twice", await fails(db, "select register_attachment($1,'import_shipment',$2,'bill_of_lading',$3,'x.pdf','x.pdf','application/pdf',10,$4,$5)",
      [director, ship, path("import_shipment", ship), sha, att1], "already superseded"));
    check("attachments cannot be overwritten", await fails(db, "update document_attachments set storage_path='x' where id=$1", [att1], "cannot be changed"));
    check("attachments cannot be deleted", await fails(db, "delete from document_attachments where id=$1", [att1], "cannot be changed"));
    check("executable / HTML types rejected", await fails(db, "select register_attachment($1,'import_shipment',$2,'other',$3,'x.html','x.html','text/html',10,$4)",
      [director, ship, path("import_shipment", ship), sha]));
    check("files over 10 MB rejected", await fails(db, "select register_attachment($1,'import_shipment',$2,'other',$3,'x.pdf','x.pdf','application/pdf',10485761,$4)",
      [director, ship, path("import_shipment", ship), sha]));
    check("unsafe download name rejected", await fails(db, "select register_attachment($1,'import_shipment',$2,'other',$3,'x.pdf','../../etc/passwd','application/pdf',10,$4)",
      [director, ship, path("import_shipment", ship), sha]));
    check("storage path must belong to the document", await fails(db, "select register_attachment($1,'import_shipment',$2,'other',$3,'x.pdf','x.pdf','application/pdf',10,$4)",
      [director, ship, path("import_shipment", fob), sha], "does not match"));
    check("storekeeper cannot attach a supplier invoice (financial)", await fails(db,
      "select register_attachment($1,'stock_transfer',$2,'supplier_invoice',$3,'x.pdf','x.pdf','application/pdf',10,$4)",
      [keeper, tr, path("stock_transfer", tr), sha], "financial"));
    check("sender-branch storekeeper can attach to the transfer", await fails(db,
      "select register_attachment($1,'stock_transfer',$2,'delivery_note',$3,'dn.pdf','dn.pdf','application/pdf',10,$4)",
      [keeper, tr, path("stock_transfer", tr), sha]) === false);
    const mwzKeeper = await mkUser("mwz@test.local", "STOREKEEPER", [mwz]);
    check("receiver-branch user can see the transfer", (await one<boolean>(db, "select can_access_document_owner($1,'stock_transfer',$2)", [mwzKeeper, tr])) === true);
    check("sender-branch user can see the transfer", (await one<boolean>(db, "select can_access_document_owner($1,'stock_transfer',$2)", [keeper, tr])) === true);
    check("third-branch user cannot see the transfer", (await one<boolean>(db, "select can_access_document_owner($1,'stock_transfer',$2)", [aruKeeper, tr])) === false);
    check("third-branch user cannot attach to it", await fails(db,
      "select register_attachment($1,'stock_transfer',$2,'photo',$3,'p.pdf','p.pdf','application/pdf',10,$4)",
      [aruKeeper, tr, path("stock_transfer", tr), sha], "not authorised"));
    check("another company's user cannot see the shipment", (await one<boolean>(db, "select can_access_document_owner($1,'import_shipment',$2)", [otherCoUser, ship])) === false);
    check("guessed owner id is denied, not an error leak", (await one<boolean>(db, "select can_access_document_owner($1,'import_shipment',gen_random_uuid())", [director])) === false);
    await db.query("update feature_flags set is_enabled=false where company_id=$1 and flag_key='attachments'", [co]);
    check("attachments blocked when the flag is off", await fails(db,
      "select register_attachment($1,'import_shipment',$2,'other',$3,'x.pdf','x.pdf','application/pdf',10,$4)",
      [director, ship, path("import_shipment", ship), sha], "not enabled"));
    check("document versions are insert-only", await (async () => {
      const id = await one(db, "insert into document_versions(company_id, owner_type, owner_id, kind, version, snapshot, content_sha256) values ($1,'stock_transfer',$2,'delivery_note',1,'{}',$3) returning id", [co, tr, sha]);
      return fails(db, "update document_versions set snapshot='{\"x\":1}' where id=$1", [id], "cannot be changed");
    })());

    console.log(`\n${passed} import Stage 2 checks passed. Rolling back.`);
  } catch (e) {
    console.error("\nImport Stage 2 test error:\n", e);
    process.exitCode = 1;
  } finally {
    await db.query("rollback");
    await db.end();
  }
}

main();
